import { log } from "../log";
import { OWNER_DO_NAME } from "../cache/sql";
import { loadListsConfig, storeListsConfig } from "../config/loader";

// Microsoft Entra v2 OAuth — pure helpers. The handler (auth/handler.ts) owns
// routing + KV state-bag lifecycle; this module owns the protocol shape and
// per-token KV persistence. As of Phase 5 the single-flight refresh discipline
// lives in the singleton TodoIndex DO (sole refresher); the per-session agent
// delegates near-expiry refreshes to it.

export const SCOPES = "Tasks.ReadWrite offline_access User.Read";
export const TOKENS_KEY = "tokens:owner";
export const IDENTITY_KEY = "identity:owner";

// My Day (opt-in) — the Substrate "My Day" endpoint is gated behind the Office
// 365 Exchange Online resource (aud = https://outlook.office.com), a DIFFERENT
// audience from Microsoft Graph. The single refresh token issued at first
// consent covers any consented resource, so we mint resource-specific access
// tokens on demand by re-requesting with the resource's scope. `offline_access`
// keeps the refresh token rotating on these mints too.
export const EXO_TASKS_SCOPE = "https://outlook.office.com/Tasks.ReadWrite";
export const SUBSTRATE_SCOPES = `${EXO_TASKS_SCOPE} offline_access`;

// Feature flag — read as a string var ("true"/"false"). String() widens the
// generated literal type so the comparison is well-typed regardless of the
// committed default in wrangler.jsonc.
export function myDayEnabled(env: Env): boolean {
  return String(env.ENABLE_MY_DAY ?? "").toLowerCase() === "true";
}

// Scopes requested at /authorize + code exchange. When My Day is enabled we add
// the EXO Tasks scope so a SINGLE consent screen covers both resources; the
// code→token exchange still returns a Graph-audience access token (Graph is
// listed first), while the refresh token covers both.
export function authScopes(env: Env): string {
  return myDayEnabled(env) ? `${SCOPES} ${EXO_TASKS_SCOPE}` : SCOPES;
}

// Refresh the Microsoft access token when it has under this much life left,
// rather than waiting for a 401 from Graph. Mirrors the plan's "proactively at
// ~80% of lifetime" rule given the standard ~1 h access-token TTL. Shared by
// the agent (decides whether to delegate) and the TodoIndex DO (sole refresher).
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

// State-bag rows under OAUTH_KV — one per in-flight authorize round.
export const STATE_KEY_PREFIX = "auth:state:";
export const STATE_TTL_SEC = 600;

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scope: string;
  obtained_at: number; // epoch ms
}

export interface TokenResponse {
  token_type: "Bearer";
  scope: string;
  expires_in: number;
  access_token: string;
  refresh_token?: string;
}

export interface AuthStateRow {
  // Base64-encoded JSON of the workers-oauth-provider parseAuthRequest result.
  oauth_req_info_b64: string;
  code_verifier: string;
  created_at: number;
}

// PKCE — Entra requires S256 for confidential web apps, but accepts plain.
// We always send S256.
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  // RFC 7636: 43–128 chars from [A-Z][a-z][0-9]-._~ — base64url of 32 random
  // bytes yields 43 chars and is always within range.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function computeCodeChallenge(verifier: string): Promise<string> {
  const enc = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return base64UrlEncode(new Uint8Array(digest));
}

export function generateStateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function tenantBase(env: Env): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(env.MS_TENANT_ID)}/oauth2/v2.0`;
}

export function buildAuthorizeUrl(
  env: Env,
  opts: { redirectUri: string; state: string; codeChallenge: string; prompt?: "consent" | "login" | "select_account" | "none" },
): string {
  const u = new URL(`${tenantBase(env)}/authorize`);
  u.searchParams.set("client_id", env.MS_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", authScopes(env));
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (opts.prompt) u.searchParams.set("prompt", opts.prompt);
  return u.toString();
}

async function postToken(env: Env, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(`${tenantBase(env)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    log.warn("ms_token_error", { status: res.status, body: text.slice(0, 500) });
    throw new TokenExchangeError(`microsoft_token_${res.status}`, text);
  }
  return JSON.parse(text) as TokenResponse;
}

export class TokenExchangeError extends Error {
  constructor(public reason: string, public detail: string) {
    super(reason);
    this.name = "TokenExchangeError";
  }
}

export async function exchangeCode(
  env: Env,
  opts: { code: string; codeVerifier: string; redirectUri: string },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    scope: authScopes(env),
    code: opts.code,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    code_verifier: opts.codeVerifier,
    client_secret: env.MS_CLIENT_SECRET,
  });
  return postToken(env, body);
}

// Refresh against an explicit scope (resource). The Microsoft v2 endpoint issues
// one access token per resource per request; the shared refresh token can mint a
// token for any consented resource by varying `scope`. Graph refreshes pass the
// Graph SCOPES; substrate refreshes pass SUBSTRATE_SCOPES. Both rotate the
// refresh token, so callers MUST serialize these (see TodoIndex sole-refresher).
export async function refreshTokensForScope(
  env: Env,
  refreshToken: string,
  scope: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    scope,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_secret: env.MS_CLIENT_SECRET,
  });
  return postToken(env, body);
}

export async function refreshTokens(env: Env, refreshToken: string): Promise<TokenResponse> {
  return refreshTokensForScope(env, refreshToken, SCOPES);
}

// Persistence — always overwrite the whole record. Microsoft MAY return a new
// refresh_token on refresh; if it does, discard the old. If it doesn't, keep
// the previously stored one (per RFC 6749 §6).
export function tokensFromResponse(
  res: TokenResponse,
  fallbackRefresh: string,
  now = Date.now(),
): StoredTokens {
  return {
    access_token: res.access_token,
    refresh_token: res.refresh_token ?? fallbackRefresh,
    expires_at: now + res.expires_in * 1000,
    scope: res.scope,
    obtained_at: now,
  };
}

export async function loadTokens(env: Env): Promise<StoredTokens | null> {
  const raw = await env.TODO_CACHE.get(TOKENS_KEY, "json");
  return (raw as StoredTokens | null) ?? null;
}

export async function storeTokens(env: Env, tokens: StoredTokens): Promise<void> {
  await env.TODO_CACHE.put(TOKENS_KEY, JSON.stringify(tokens));
}

// State-bag helpers — auth/handler.ts persists oauthReqInfo + codeVerifier
// across the Microsoft round-trip. Keyed by the opaque state token sent to
// Microsoft. One-shot: callback consumes and deletes.
export async function putAuthState(env: Env, stateToken: string, row: AuthStateRow): Promise<void> {
  await env.OAUTH_KV.put(STATE_KEY_PREFIX + stateToken, JSON.stringify(row), {
    expirationTtl: STATE_TTL_SEC,
  });
}

export async function takeAuthState(env: Env, stateToken: string): Promise<AuthStateRow | null> {
  const key = STATE_KEY_PREFIX + stateToken;
  const row = await env.OAUTH_KV.get(key, "json");
  if (row) await env.OAUTH_KV.delete(key);
  return (row as AuthStateRow | null) ?? null;
}

// Owner-identity gate. The /me response shape varies — personal-MSA-in-tenant
// accounts may have mail: null and only userPrincipalName populated. Either
// is an acceptable identity claim.
export interface MeIdentity {
  id: string;
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
}

export async function fetchMe(accessToken: string): Promise<MeIdentity> {
  const res = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`graph_me_${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as MeIdentity;
}

// Decode the (unverified) claims from a JWT's payload segment. We only read it
// to extract the tenant id (`tid`) from our OWN freshly-issued access token at
// callback time — never to make a trust decision — so signature verification is
// unnecessary here. base64url → base64 with padding, then atob + JSON.parse.
// Returns null on any malformed input rather than throwing.
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(b64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// x-anchormailbox value the Substrate endpoint wants so other connected To Do
// clients see a My Day change in real time. Format: OID:{oid}@{tid}.
export function buildAnchorMailbox(oid: string, tid: string): string {
  return `OID:${oid}@${tid}`;
}

export function isOwner(env: Env, me: MeIdentity): boolean {
  const expected = env.OWNER_EMAIL.trim().toLowerCase();
  const candidates = [me.mail, me.userPrincipalName]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => v.trim().toLowerCase());
  return candidates.includes(expected);
}

// Owner identity record — written on every successful /authorize. Used by
// the handler to detect when the underlying Microsoft account changes (e.g.
// owner swapped M365 tenants) so we can wipe per-identity cache without
// silently mixing tasks from two accounts.
export interface OwnerIdentity {
  id: string; // Graph /me.id — stable across mail/displayName changes
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
  first_seen: number; // epoch ms — first time we saw this id
  last_seen: number; // epoch ms — most recent successful /authorize
  // OID:{oid}@{tid} for the Substrate x-anchormailbox header (My Day). Optional:
  // identities stored before the My Day feature lack it until the next
  // /authorize. The substrate client tolerates a null anchor (the write still
  // persists; other clients just see it on their next poll).
  anchorMailbox?: string;
}

export async function loadIdentity(env: Env): Promise<OwnerIdentity | null> {
  return ((await env.TODO_CACHE.get(IDENTITY_KEY, "json")) as OwnerIdentity | null) ?? null;
}

export async function storeIdentity(env: Env, ident: OwnerIdentity): Promise<void> {
  await env.TODO_CACHE.put(IDENTITY_KEY, JSON.stringify(ident));
}

// Wipe ALL identity-scoped state when an /authorize round completes with a
// different Microsoft /me.id than the previously stored identity. As of Phase 5
// that state spans two stores: the TODO_CACHE KV keys (tokens + identity) and
// the TodoIndex DO (the previous identity's tasks/lists/sync cursors — these
// replaced the old lists:all / tasks:{listId} / etag:{listId} KV keys). Both
// are cleared here so two accounts' data can never mix. OAUTH_KV grants
// (Claude.ai-side DCR sessions) are NOT touched here — see README "Reset"
// section for manual cleanup.
//
// Ordering is load-bearing (H3, fail-closed):
//   1. Wipe the DO first. If resetIdentity() throws, nothing else has run, so
//      /authorize aborts before storeTokens and the prior identity's state stays
//      intact and consistent — never a half-wipe.
//   2. Delete the KV identity marker LAST. If a KV delete throws after the DO
//      wipe, the identity marker still names the OLD id, so the next /authorize
//      re-detects the change and re-wipes (resetIdentity is idempotent) instead
//      of silently skipping the wipe (prevIdentity === null) and letting the new
//      baseline mix with leftover old-account rows.
export async function wipeIdentityScopedState(env: Env): Promise<void> {
  const index = env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName(OWNER_DO_NAME));
  await index.resetIdentity();
  await env.TODO_CACHE.delete(TOKENS_KEY);
  await env.TODO_CACHE.delete(IDENTITY_KEY);

  // Feature A — best-effort: clear per-account aliases (they reference the PRIOR
  // account's Graph list IDs, so every alias would resolve to a dead ID -> Graph
  // 404). Patterns are display-name regexes (inert if unmatched, encode user
  // intent) and stay. no_sync wellknown entries stay valid across accounts.
  // Own try/catch so a stale alias never aborts the fail-closed wipe above, and
  // placed AFTER the critical deletes so it can't affect them.
  try {
    const cfg = await loadListsConfig(env);
    if (Object.keys(cfg.aliases).length > 0) {
      await storeListsConfig(env, { ...cfg, aliases: {} });
    }
  } catch (e) {
    log.warn("identity_wipe_alias_clear_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
