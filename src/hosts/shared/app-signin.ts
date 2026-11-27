// The app's sign-in path when Cloudflare Access is in front (docs/SYNC-API.md
// section 8.1), and the hand-over of the Access token to the app.
//
//   GET /app/signin?<the app's OAuth authorization parameters>
//     Behind Access. Verifies the Access JWT (signature, audience, issuer,
//     lifetime, owner email), requires the redirect URI to be listed in
//     ACCESS_HANDOFF_REDIRECT_URIS, stores it server-side for ten minutes under a
//     random handle bound to the request's client_id, redirect_uri and PKCE
//     challenge, sets that handle in a __Host- cookie, and redirects to
//     /authorize with the same parameters. From there the flow is the one every
//     client gets: consent page, Microsoft sign-in, OWNER_EMAIL gate.
//   GET /auth/microsoft/callback
//     If the cookie is present and the stored record matches the authorization
//     being completed, the handle goes into the new grant's props
//     (attachAccessHandoff).
//   POST /token (authorization_code)
//     The token callback takes the handle out of the grant's props and the
//     OAuth front adds the stored Access token to the token response as
//     `cf_access_token` (redeemAccessHandoff). The library has already checked
//     the code, PKCE verifier and exact redirect_uri by then.
//
// The Access token never appears in a redirect URL (section 18.7). Off (Access
// not configured), /app/signin is not served and no handle is ever attached.
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { checkAccess, handoffRedirectAllowed } from "@potem/core/auth/access";
import { seal, unseal } from "@potem/core/auth/crypto";
import { log } from "@potem/core/log";
import type { AppEnv } from "@potem/core/ports";
import { API_PATH } from "@potem/core/api/router";
import { errorPage } from "./consent-page";

export const APP_SIGNIN_PATH = "/app/signin";
export const HANDOFF_COOKIE = "__Host-mstodo-access-handoff";
const HANDOFF_TTL_SEC = 600;
const KV_PREFIX = "access_handoff:";
const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;
const SINGLE_PARAMS = ["resource", "client_id", "redirect_uri", "code_challenge"];

interface HandoffRecord {
  sealed: string; // the Access JWT, sealed with MS_CLIENT_SECRET's derived key
  exp: number; // its expiry, seconds since the epoch
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
}

const kvKey = (handle: string) => `${KV_PREFIX}${handle}`;

function randomHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const clearHandoffCookie = `${HANDOFF_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

// GET /app/signin. Null when Access is off, so the path stays a 404 as before.
export async function handleAppSignin(req: Request, env: AppEnv, origin: string): Promise<Response | null> {
  const check = await checkAccess(req.headers, env, { cookie: true, path: APP_SIGNIN_PATH });
  if (check.state === "off") return null;
  if (check.state === "refused") {
    if (check.error === "access_misconfigured") {
      return errorPage("Sign-in unavailable", "This server's Cloudflare Access settings are incomplete.", 503);
    }
    if (check.error === "access_unavailable") {
      return errorPage("Sign-in unavailable", "Cloudflare Access can't be checked right now. Try again in a minute.", 503);
    }
    return errorPage("Not authorized", "Sign in through Cloudflare Access as this server's owner, then try again.", 403);
  }
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });

  const url = new URL(req.url);
  const q = url.searchParams;
  // A repeated parameter could be read one way here and another way by
  // /authorize; refuse it rather than pick one.
  if (SINGLE_PARAMS.some((p) => q.getAll(p).length > 1)) {
    return errorPage("Invalid sign-in request", "A sign-in parameter appears more than once.", 400);
  }
  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri");
  const challenge = q.get("code_challenge");
  // This path exists for the app's resource only. The library validates the
  // client, redirect URI and the rest at /authorize.
  if (
    q.get("response_type") !== "code" ||
    !clientId ||
    !redirectUri ||
    !challenge ||
    q.get("code_challenge_method") !== "S256" ||
    q.get("resource") !== `${origin}${API_PATH}`
  ) {
    return errorPage(
      "Invalid sign-in request",
      `The app's sign-in request must ask for an authorization code with S256 PKCE for ${origin}${API_PATH}.`,
      400,
    );
  }

  if (!handoffRedirectAllowed(env, redirectUri)) {
    log.warn("app_signin_redirect_not_allowed", { client_id: clientId });
    return errorPage("Invalid sign-in request", "This redirect URI isn't one of the app's sign-in redirect URIs.", 400);
  }

  const handle = randomHandle();
  const record: HandoffRecord = {
    sealed: await seal(env, check.token, kvKey(handle)),
    exp: check.exp,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
  };
  await env.OAUTH_KV.put(kvKey(handle), JSON.stringify(record), { expirationTtl: HANDOFF_TTL_SEC });
  log.info("app_signin_started", { client_id: clientId });
  return new Response(null, {
    status: 302,
    headers: {
      location: `${origin}/authorize?${q}`,
      "set-cookie": `${HANDOFF_COOKIE}=${handle}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${HANDOFF_TTL_SEC}`,
      "cache-control": "no-store",
    },
  });
}

// At the Microsoft callback, after the owner gate: the handle to put in the
// grant's props when this browser started at /app/signin for this same
// authorization, else null. Always clears the cookie (one use). A record that
// doesn't match is deleted.
export async function attachAccessHandoff(
  req: Request,
  env: AppEnv,
  authRequest: AuthRequest,
  headers: Headers,
): Promise<string | null> {
  const handle = cookieValue(req, HANDOFF_COOKIE);
  if (handle === null) return null;
  headers.append("set-cookie", clearHandoffCookie);
  if (!HANDLE_RE.test(handle)) return null;
  const record = await env.OAUTH_KV.get<HandoffRecord>(kvKey(handle), "json");
  if (!record) return null;
  if (
    record.client_id !== authRequest.clientId ||
    record.redirect_uri !== authRequest.redirectUri ||
    record.code_challenge !== authRequest.codeChallenge ||
    !handoffRedirectAllowed(env, authRequest.redirectUri)
  ) {
    log.warn("access_handoff_mismatch", { client_id: authRequest.clientId });
    await env.OAUTH_KV.delete(kvKey(handle));
    return null;
  }
  return handle;
}

// At code redemption: the stored Access token for `handle`, once. Null when it
// is gone (expired, used) or the token itself has expired.
export async function redeemAccessHandoff(
  env: AppEnv,
  handle: string,
): Promise<{ token: string; exp: number } | null> {
  if (!HANDLE_RE.test(handle)) return null;
  const record = await env.OAUTH_KV.get<HandoffRecord>(kvKey(handle), "json");
  if (!record) return null;
  await env.OAUTH_KV.delete(kvKey(handle));
  if (record.exp * 1000 <= Date.now()) return null;
  try {
    return { token: await unseal(env, record.sealed, kvKey(handle)), exp: record.exp };
  } catch {
    return null;
  }
}

// The props key that carries the handle from the callback to /token.
export const HANDOFF_PROP = "access_handoff";

// A slot the token callback fills, so the front can add the Access token to
// that same response. One per /token request.
export const HANDOFF_SLOT: unique symbol = Symbol("access-handoff-slot");
export interface HandoffSlot {
  handle?: string;
}

// The token response with the Access token added. Leaves anything but a JSON
// 200 alone.
export async function withAccessToken(res: Response, access: { token: string; exp: number }): Promise<Response> {
  if (res.status !== 200 || !res.headers.get("content-type")?.includes("application/json")) return res;
  const body = (await res.json()) as Record<string, unknown>;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...body, cf_access_token: access.token, cf_access_expires_at: access.exp }), {
    status: 200,
    headers,
  });
}
