// Sign-in, callback and logout. The BFF is an OAuth client of potem-server:
// each browser registers its own confidential client (the device cookie), so a
// sign-in on one browser never ends another's grant, and the tokens live only
// in the sealed session cookie.
//
// "oauth-provider.js" below is node_modules/@cloudflare/workers-oauth-provider/
// dist/oauth-provider.js (1.2.3); line numbers point at the behaviour relied on.

import { DEVICE_COOKIE, LOGIN_COOKIE, SESSION_COOKIE, clearCookie, cookieHeader, readCookie } from "./cookies.ts";
import { type Sealer, sealer } from "./seal.ts";
import { type Device, type Session, deviceFor, isDevice, isSession } from "./session.ts";
import { type BffConfig, basicAuth, serverUsesAccess } from "./upstream.ts";

const DEVICE_MAX_AGE_SEC = 400 * 86_400;
const LOGIN_MAX_AGE_SEC = 600;
const CALLBACK_PATH = "/auth/callback";
const LOGIN_PATH = "/auth/login";
// Keeps a long return_to from pushing the login cookie past its size limit.
const MAX_RETURN_TO = 1024;

/** The login cookie: one sign-in between /auth/login and /auth/callback. */
type LoginState = {
  state: string;
  verifier: string;
  return_to: string;
  /** Login went through /app/signin (Cloudflare Access in front). */
  access: boolean;
  /** The client the authorization was started for; another device cookie at the callback is refused. */
  client_id: string;
  /** Set after one re-registration for invalid_client, so a second one ends on the error page. */
  retry?: boolean;
};

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function isLoginState(v: unknown): v is LoginState {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    nonEmpty(l.state) &&
    nonEmpty(l.verifier) &&
    nonEmpty(l.return_to) &&
    nonEmpty(l.client_id) &&
    typeof l.access === "boolean" &&
    (l.retry === undefined || typeof l.retry === "boolean")
  );
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

async function readSealed<T>(req: Request, s: Sealer, name: string, guard: (v: unknown) => v is T): Promise<T | null> {
  const raw = readCookie(req, name);
  if (!raw) return null;
  const v = await s.unseal<unknown>(name, raw);
  return guard(v) ? v : null;
}

/** The session cookie's record, or null when absent, unreadable or malformed. */
export function readSession(req: Request, s: Sealer): Promise<Session | null> {
  return readSealed(req, s, SESSION_COOKIE, isSession);
}

/** This browser's client registration for cfg.serverOrigin, or null. */
export async function readDevice(req: Request, s: Sealer, cfg: BffConfig): Promise<Device | null> {
  return deviceFor(await readSealed(req, s, DEVICE_COOKIE, isDevice), cfg.serverOrigin);
}

/** Whether a state-changing request came from the web app itself. */
export function csrfOk(req: Request, cfg: BffConfig): boolean {
  return req.headers.get("x-potem") === "1" && req.headers.get("origin") === cfg.webOrigin;
}

/**
 * A same-origin path to return to after sign-in, or "/". Resolved against the
 * web origin, so "//host", "/\host" and absolute URLs (which a browser reads
 * as another host) fall back.
 */
function safeReturnTo(raw: string | null, webOrigin: string): string {
  if (!raw || raw.length > MAX_RETURN_TO || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/";
  }
  try {
    const u = new URL(raw, webOrigin);
    return u.origin === webOrigin ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function errorPage(status: number, title: string, detail: string, cookies: string[] = []): Response {
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
<p><a href="${LOGIN_PATH}">Sign in again</a></p>
</html>
`;
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(html, { status, headers });
}

const unavailable = (detail = "The Potem server can't be reached. Try again in a minute.", cookies: string[] = []) =>
  errorPage(502, "Sign-in unavailable", detail, [...cookies, clearCookie(LOGIN_COOKIE)]);

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

/**
 * Dynamic client registration. The library answers 201 with a client_secret
 * for every auth method but "none" (handleClientRegistration in
 * oauth-provider.js, lines 4376-4449). Throws on anything else.
 */
async function register(cfg: BffConfig): Promise<Device> {
  const res = await cfg.upstream("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Potem Web",
      redirect_uris: [`${cfg.webOrigin}${CALLBACK_PATH}`],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
    }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const device = { client_id: body?.client_id, client_secret: body?.client_secret, server_origin: cfg.serverOrigin };
  if (res.status !== 201 || !isDevice(device)) throw new Error(`register answered ${res.status}`);
  return device;
}

/**
 * Whether the server still knows this client, checked with a revocation call
 * for a random token. The library authenticates the client first, answering
 * 401 invalid_client when it's gone (parseTokenEndpointRequest in
 * oauth-provider.js, lines 3189 and 3217), then answers 200 for a token that
 * isn't three ":"-parts without looking anything up (revokeToken, lines
 * 4255-4256); a 200 also renews the registration's expiry (line 2931).
 * Without this, a registration that expired while the device cookie lived on
 * would end every sign-in at the server's "Invalid client_id" page, which
 * never redirects back here. Throws on any other answer, so a transient
 * failure doesn't mint a new client.
 */
async function clientIsKnown(cfg: BffConfig, device: Device): Promise<boolean> {
  const res = await cfg.upstream("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(device) },
    body: new URLSearchParams({ token: base64Url(cfg.random(32)) }),
  });
  if (res.ok) {
    await res.body?.cancel();
    return true;
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (body?.error === "invalid_client") return false;
  throw new Error(`client check answered ${res.status}`);
}

/** GET /auth/login?return_to=<path> */
export async function handleLogin(req: Request, cfg: BffConfig): Promise<Response> {
  const s = await sealer(cfg.secret);
  const returnTo = safeReturnTo(new URL(req.url).searchParams.get("return_to"), cfg.webOrigin);
  // A login cookie marked retry is the one handleCallback wrote before sending
  // the browser back here after invalid_client; the mark carries over.
  const retry = (await readSealed(req, s, LOGIN_COOKIE, isLoginState))?.retry === true;
  const cookies: string[] = [];

  let device = await readDevice(req, s, cfg);
  let access: boolean;
  try {
    // At most one registration per login: a client registered here isn't checked.
    if (device && !(await clientIsKnown(cfg, device))) device = null;
    if (!device) {
      device = await register(cfg);
      cookies.push(cookieHeader(DEVICE_COOKIE, await s.seal(DEVICE_COOKIE, device), DEVICE_MAX_AGE_SEC));
    }
    access = await serverUsesAccess(cfg.upstream);
  } catch {
    // A client registered before the failure is kept, so the next attempt
    // doesn't register another.
    return unavailable(undefined, cookies);
  }

  const login: LoginState = {
    state: base64Url(cfg.random(32)),
    verifier: base64Url(cfg.random(32)),
    return_to: returnTo,
    access,
    client_id: device.client_id,
    ...(retry ? { retry: true } : {}),
  };
  cookies.push(cookieHeader(LOGIN_COOKIE, await s.seal(LOGIN_COOKIE, login), LOGIN_MAX_AGE_SEC));

  // /app/signin takes the same parameters and requires code_challenge_method
  // and this exact resource (workers/server/src/hosts/shared/app-signin.ts,
  // lines 91-104). Neither needs a scope: the library reads it as optional
  // (parseAuthRequest in oauth-provider.js, line 5520).
  const target = new URL(access ? "/app/signin" : "/authorize", cfg.serverOrigin);
  target.search = new URLSearchParams({
    response_type: "code",
    client_id: device.client_id,
    redirect_uri: `${cfg.webOrigin}${CALLBACK_PATH}`,
    state: login.state,
    code_challenge: await s256(login.verifier),
    code_challenge_method: "S256",
    resource: `${cfg.serverOrigin}/api/v1`,
  }).toString();
  return redirect(target.toString(), cookies);
}

/** GET /auth/callback?code=…&state=… (or ?error=…) */
export async function handleCallback(req: Request, cfg: BffConfig): Promise<Response> {
  const s = await sealer(cfg.secret);
  const q = new URL(req.url).searchParams;

  // A callback without this sign-in's state leaves the login cookie alone: a
  // forged callback must not be able to cancel a sign-in in progress.
  const login = await readSealed(req, s, LOGIN_COOKIE, isLoginState);
  const state = q.get("state");
  const stateMatches = login !== null && state !== null && state === login.state;

  const error = q.get("error");
  if (error !== null) {
    const description = q.get("error_description");
    return errorPage(
      400,
      "Sign-in didn't finish",
      description ? `${error}: ${description}` : error,
      stateMatches ? [clearCookie(LOGIN_COOKIE)] : [],
    );
  }
  if (!login || !stateMatches) {
    return errorPage(400, "Sign-in expired", "This sign-in doesn't match one started in this browser.");
  }
  const device = await readDevice(req, s, cfg);
  if (!device || device.client_id !== login.client_id) {
    return errorPage(400, "Sign-in expired", "This browser's registration changed during sign-in.", [
      clearCookie(LOGIN_COOKIE),
    ]);
  }
  const code = q.get("code");
  if (!code) {
    return errorPage(400, "Sign-in didn't finish", "The server returned no authorization code.", [
      clearCookie(LOGIN_COOKIE),
    ]);
  }

  // The library takes the client from the Basic header and refuses a
  // client_id or client_secret in the body alongside it (parseTokenEndpointRequest
  // in oauth-provider.js, lines 3137-3150). An unknown client or a wrong secret
  // is 401 {"error":"invalid_client"} (createInvalidClientResponse, line 3073).
  let res: Response;
  try {
    res = await cfg.upstream("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(device) },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${cfg.webOrigin}${CALLBACK_PATH}`,
        code_verifier: login.verifier,
      }),
    });
  } catch {
    return unavailable();
  }
  if (res.status >= 500) {
    await res.body?.cancel();
    return unavailable();
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (body?.error === "invalid_client") {
    // The registration expired or was deleted: register again and restart the
    // login, once.
    if (login.retry) return unavailable("The Potem server refused this browser's registration.");
    const back = new URL(LOGIN_PATH, cfg.webOrigin);
    back.searchParams.set("return_to", login.return_to);
    return redirect(back.toString(), [
      clearCookie(DEVICE_COOKIE),
      cookieHeader(LOGIN_COOKIE, await s.seal(LOGIN_COOKIE, { ...login, retry: true }), LOGIN_MAX_AGE_SEC),
    ]);
  }
  if (res.status !== 200 || !body) {
    const detail = typeof body?.error === "string" ? body.error : `status ${res.status}`;
    return errorPage(400, "Sign-in didn't finish", `The server refused the sign-in (${detail}).`, [
      clearCookie(LOGIN_COOKIE),
    ]);
  }

  // The library's token response carries access_token, refresh_token and
  // expires_in (oauth-provider.js, lines 3637-3654). Behind Access, the front
  // adds cf_access_token and cf_access_expires_at in epoch seconds
  // (workers/server/src/hosts/shared/app-signin.ts, withAccessToken, line 195).
  const now = cfg.now();
  const session = {
    access_token: body.access_token,
    access_exp: now + (body.expires_in as number),
    refresh_token: body.refresh_token,
    data_key: base64Url(cfg.random(32)),
    created_at: now,
    last_seen: now,
    ...(typeof body.cf_access_token === "string" ? { cf_access_token: body.cf_access_token } : {}),
    ...(Number.isFinite(body.cf_access_expires_at) ? { cf_access_exp: body.cf_access_expires_at } : {}),
  };
  if (!isSession(session)) return unavailable("The Potem server sent an unexpected token response.");
  const sealed = await s.seal(SESSION_COOKIE, session);
  let sessionCookie: string;
  try {
    sessionCookie = cookieHeader(SESSION_COOKIE, sealed, cfg.maxHours * 3600);
  } catch {
    // Over the cookie size cap, most likely a large cf_access_token. The size
    // only: the record holds the tokens. Same line shape as core/log.ts.
    console.warn(JSON.stringify({ level: "warn", event: "session_cookie_too_large", bytes: sealed.length }));
    return unavailable("The sign-in response was too large to store.");
  }
  return redirect(`${cfg.webOrigin}${login.return_to}`, [sessionCookie, clearCookie(LOGIN_COOKIE)]);
}

/** POST /auth/logout */
export async function handleLogout(req: Request, cfg: BffConfig): Promise<Response> {
  if (!csrfOk(req, cfg)) return new Response(null, { status: 403 });
  const s = await sealer(cfg.secret);
  const session = await readSession(req, s);
  const device = await readDevice(req, s, cfg);
  if (session && device) {
    // RFC 7009: a token and no grant_type. The library authenticates the
    // client as for any /token call, then revokes the whole grant for a refresh
    // token that belongs to it (oauth-provider.js, line 3221; revokeToken and
    // revokeRefreshIfOwned, lines 4248-4287).
    try {
      const res = await cfg.upstream("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(device) },
        body: new URLSearchParams({ token: session.refresh_token, token_type_hint: "refresh_token" }),
      });
      await res.body?.cancel();
    } catch {
      // The cookie is cleared regardless; an unrevoked grant lapses with its
      // refresh token.
    }
  }
  return new Response(null, { status: 204, headers: { "set-cookie": clearCookie(SESSION_COOKIE) } });
}
