// Cloudflare Access as a second gate in front of the app's paths
// (docs/SYNC-API.md section 8.1). Access checks the person at the edge; this
// module checks, in the server, that a request really passed Access for this
// application and for the owner: the Access JWT's RS256 signature against the
// team's published keys, its issuer, audience, lifetime and email.
//
// The feature is off unless both ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, and
// then nothing here runs. With only one of them set the configuration is
// refused (fail closed): a half-configured gate must not silently open.
//
// Host-neutral: fetch and WebCrypto only, so both hosts share it.
import { log } from "../log";
import { json } from "../api/respond";
import type { AppEnv } from "../ports";

export interface AccessConfig {
  // https://<team>.cloudflareaccess.com — the JWT issuer and the keys' host.
  issuer: string;
  certsUrl: string;
  // The Access application's audience tag.
  aud: string;
}

export type AccessSetting =
  | { state: "off" }
  | { state: "on"; config: AccessConfig }
  | { state: "invalid"; reason: string };

type AccessEnv = Pick<AppEnv, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">;

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))+$/;
const AUD_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function accessSetting(env: AccessEnv): AccessSetting {
  const team = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
  const aud = (env.ACCESS_AUD ?? "").trim();
  if (!team && !aud) return { state: "off" };
  if (!team || !aud) return { state: "invalid", reason: team ? "ACCESS_AUD is not set" : "ACCESS_TEAM_DOMAIN is not set" };
  // Accepts "team.cloudflareaccess.com" or "https://team.cloudflareaccess.com[/]".
  const host = team.replace(/^https:\/\//i, "").replace(/\/$/, "").toLowerCase();
  if (!HOST_RE.test(host)) return { state: "invalid", reason: "ACCESS_TEAM_DOMAIN is not a host name" };
  if (!AUD_RE.test(aud)) return { state: "invalid", reason: "ACCESS_AUD is not an audience tag" };
  const issuer = `https://${host}`;
  return { state: "on", config: { issuer, certsUrl: `${issuer}/cdn-cgi/access/certs`, aud } };
}

// Why a token was refused. Logged; never the token or its claims.
export type AccessFailure =
  | "missing"
  | "malformed"
  | "unsupported_alg"
  | "unknown_key"
  | "keys_unavailable"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "not_owner";

export type AccessVerdict =
  | { ok: true; token: string; exp: number } // exp: seconds since the epoch
  | { ok: false; reason: AccessFailure };

// Clock skew allowed on exp and nbf.
export const ACCESS_CLOCK_SKEW_SEC = 60;
const MAX_TOKEN_CHARS = 16 * 1024;
const MAX_CERTS_BYTES = 64 * 1024;

// --- the team's signing keys -------------------------------------------------
//
// Cached per isolate/process, per certs URL. Access rotates its keys every six
// weeks and keeps serving the old one for a while, so a fresh copy each hour is
// plenty. A token signed by a key we don't hold triggers a refetch at once (a
// rotation), but at most once a minute, so a stream of tokens with made-up key
// IDs can't turn into a stream of fetches. When a refetch fails, keys fetched
// in the last day keep working; older ones don't.
export const KEYS_FRESH_MS = 3_600_000;
export const KEYS_REFETCH_MIN_MS = 60_000;
export const KEYS_MAX_STALE_MS = 24 * 3_600_000;
export const KEYS_FETCH_TIMEOUT_MS = 5_000;

interface KeySet {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}
interface KeyCache {
  set?: KeySet;
  lastAttempt?: number;
  inflight?: Promise<void>;
}
const keyCaches = new Map<string, KeyCache>();

// Tests only: forget every cached key set.
export function resetAccessKeyCache(): void {
  keyCaches.clear();
}

async function fetchKeys(certsUrl: string): Promise<Map<string, CryptoKey>> {
  // Bounded and never redirected: the keys come from the team's own host. The
  // timer is cleared once the body is in, so no timer outlives the fetch.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("certs fetch timed out")), KEYS_FETCH_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetch(certsUrl, { headers: { accept: "application/json" }, redirect: "error", signal: abort.signal });
    if (res.status !== 200) throw new Error(`certs answered ${res.status}`);
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  if (text.length > MAX_CERTS_BYTES) throw new Error("certs response too large");
  const body = JSON.parse(text) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error("certs response has no keys");
  const keys = new Map<string, CryptoKey>();
  for (const k of body.keys as Array<Record<string, unknown>>) {
    if (!k || k.kty !== "RSA" || typeof k.kid !== "string" || typeof k.n !== "string" || typeof k.e !== "string") continue;
    if (k.alg !== undefined && k.alg !== "RS256") continue;
    if (k.use !== undefined && k.use !== "sig") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(k.kid, key);
    } catch {
      // A key we can't import can't verify anything; skip it.
    }
  }
  if (!keys.size) throw new Error("certs response has no usable RS256 key");
  return keys;
}

async function signingKey(
  certsUrl: string,
  kid: string,
  now: number,
): Promise<{ key: CryptoKey } | { reason: "unknown_key" | "keys_unavailable" }> {
  let cache = keyCaches.get(certsUrl);
  if (!cache) keyCaches.set(certsUrl, (cache = {}));
  const fresh = cache.set && now - cache.set.fetchedAt < KEYS_FRESH_MS;
  if (fresh && cache.set!.keys.has(kid)) return { key: cache.set!.keys.get(kid)! };

  // Stale, empty, or a key we don't hold: refetch, unless one ran recently.
  if (cache.inflight) {
    await cache.inflight;
  } else if (cache.lastAttempt === undefined || now - cache.lastAttempt >= KEYS_REFETCH_MIN_MS) {
    cache.lastAttempt = now;
    const c = cache;
    c.inflight = fetchKeys(certsUrl)
      .then((keys) => {
        c.set = { keys, fetchedAt: now };
      })
      .catch((e: unknown) => {
        log.warn("access_keys_fetch_failed", { error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        c.inflight = undefined;
      });
    await c.inflight;
  }

  const set = cache.set;
  if (!set || now - set.fetchedAt >= KEYS_MAX_STALE_MS) return { reason: "keys_unavailable" };
  const key = set.keys.get(kid);
  return key ? { key } : { reason: "unknown_key" };
}

// --- the token ---------------------------------------------------------------

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Verifies an Access JWT for this application and the owner. Signature first;
// no claim is read as fact before it.
export async function verifyAccessJwt(
  token: string | null,
  config: AccessConfig,
  ownerEmail: string,
  opts: { now?: number } = {},
): Promise<AccessVerdict> {
  if (!token) return { ok: false, reason: "missing" };
  const now = opts.now ?? Date.now();
  if (token.length > MAX_TOKEN_CHARS) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => B64URL_RE.test(p))) return { ok: false, reason: "malformed" };
  const header = b64urlJson(parts[0]);
  if (!header) return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported_alg" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "malformed" };

  const found = await signingKey(config.certsUrl, header.kid, now);
  if ("reason" in found) return { ok: false, reason: found.reason };
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      found.key,
      b64urlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  const claims = b64urlJson(parts[1]);
  if (!claims) return { ok: false, reason: "malformed" };
  if (claims.iss !== config.issuer) return { ok: false, reason: "wrong_issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.aud)) return { ok: false, reason: "wrong_audience" };
  const nowSec = now / 1000;
  if (typeof claims.exp !== "number" || nowSec > claims.exp + ACCESS_CLOCK_SKEW_SEC) return { ok: false, reason: "expired" };
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || nowSec + ACCESS_CLOCK_SKEW_SEC < claims.nbf)) {
    return { ok: false, reason: "not_yet_valid" };
  }
  // Service tokens carry no email, so they never pass as the owner.
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email || email !== ownerEmail.trim().toLowerCase()) return { ok: false, reason: "not_owner" };
  return { ok: true, token, exp: claims.exp };
}

// --- requests ----------------------------------------------------------------

export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
export const ACCESS_TOKEN_HEADER = "cf-access-token";
export const ACCESS_COOKIE = "CF_Authorization";

// The Access token a request carries, from the first source present:
// - Cf-Access-Jwt-Assertion, which Access adds to every request it lets through;
// - cf-access-token, which a native client sends (and Access validates) when
//   Access is in front, and which reaches the server as sent when it isn't;
// - the CF_Authorization cookie, browser requests only (`cookie: true`).
// The first source present is the only one checked: a bad assertion is not
// rescued by a good cookie.
export function accessTokenFrom(headers: Headers, opts: { cookie: boolean }): string | null {
  const assertion = headers.get(ACCESS_ASSERTION_HEADER);
  if (assertion) return assertion.trim();
  const token = headers.get(ACCESS_TOKEN_HEADER);
  if (token) return token.trim();
  if (!opts.cookie) return null;
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === ACCESS_COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export type AccessCheck =
  | { state: "off" }
  | { state: "passed"; token: string; exp: number }
  | {
      state: "refused";
      status: 403 | 503;
      error: "access_denied" | "access_misconfigured" | "access_unavailable";
    };

// The whole check for one request. "off" when Access isn't configured: the
// caller then behaves exactly as without this module.
export async function checkAccess(
  headers: Headers,
  env: AccessEnv & Pick<AppEnv, "OWNER_EMAIL">,
  opts: { cookie: boolean; path: string },
): Promise<AccessCheck> {
  const setting = accessSetting(env);
  if (setting.state === "off") return { state: "off" };
  if (setting.state === "invalid") {
    log.error("access_misconfigured", { reason: setting.reason, path: opts.path });
    return { state: "refused", status: 503, error: "access_misconfigured" };
  }
  const verdict = await verifyAccessJwt(accessTokenFrom(headers, opts), setting.config, env.OWNER_EMAIL);
  if (!verdict.ok) {
    log.warn("access_refused", { reason: verdict.reason, path: opts.path });
    // The team's keys couldn't be fetched: the token may be fine, so the
    // client retries instead of signing in again.
    if (verdict.reason === "keys_unavailable") return { state: "refused", status: 503, error: "access_unavailable" };
    return { state: "refused", status: 403, error: "access_denied" };
  }
  return { state: "passed", token: verdict.token, exp: verdict.exp };
}

// The API's answer to a refused check: JSON, never cached.
export function accessRefusalResponse(check: Extract<AccessCheck, { state: "refused" }>): Response {
  return json({ error: check.error }, check.status, check.error === "access_unavailable" ? { "retry-after": "30" } : {});
}

// Whether the Access token may be handed to `redirectUri`: only an exact
// entry of ACCESS_HANDOFF_REDIRECT_URIS. Consent to some other client must not
// yield the owner's Access token, or Access stops being an independent gate.
export function handoffRedirectAllowed(env: Pick<AppEnv, "ACCESS_HANDOFF_REDIRECT_URIS">, redirectUri: string): boolean {
  return (env.ACCESS_HANDOFF_REDIRECT_URIS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean)
    .includes(redirectUri);
}
