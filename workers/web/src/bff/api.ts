// The session endpoint, the refresh, and the read-only proxy to the server's
// sync API (docs/SYNC-API.md).
//
// Only GET /bff/session and POST /bff/session/refresh (with sign-in, callback
// and logout in auth.ts) write the session cookie with a new record. A proxied
// /bff/api response never does: the browser sends many of those at once, and
// one that rewrote the cookie from the record it arrived with would put back
// the refresh token a refresh racing alongside had just replaced. So the idle
// timer's last_seen is touched only by GET /bff/session, at most once a
// minute, and the page calls it on user activity. Likewise the proxy never
// refreshes: near expiry it answers 401 session_refresh_needed, and the page
// sends one POST /bff/session/refresh for all of them. That refresh rotates
// only a session that is due: two tabs refreshing at once would otherwise
// rotate twice from the same token, and if the first response's cookie landed
// last it would hold a token that is neither current nor previous.
//
// "oauth-provider.js" below is node_modules/@cloudflare/workers-oauth-provider/
// dist/oauth-provider.js (1.2.3).

import { csrfOk, readDevice, readSession } from "./auth.ts";
import { SESSION_COOKIE, clearCookie, cookieHeader, readCookie } from "./cookies.ts";
import { type Sealer, sealer } from "./seal.ts";
import { type Device, type Session, isSession, sessionState } from "./session.ts";
import { type BffConfig, basicAuth } from "./upstream.ts";

const API_PREFIX = "/bff/api/";
/** last_seen is rewritten when it is at least this old. */
const TOUCH_INTERVAL_SEC = 60;
const REFRESH_RETRY_DELAY_MS = 1000;
/** The response headers a proxied response keeps. Set-Cookie is never among them. */
const PASSED_HEADERS = ["content-type", "content-disposition", "content-length", "etag", "last-modified"];

const ID = "[A-Za-z0-9_-]{1,128}";
/** The sync API paths the web app reads, after /api/v1/. */
const ALLOWLIST = [
  "sync/info",
  "sync/changes",
  "search",
  `tasks/${ID}`,
  `attachments/${ID}`,
  `theme-images/${ID}`,
  "link-rules",
  "lists/excluded",
].map((p) => new RegExp(`^${p}$`));

export function jsonResponse(body: unknown, status: number, cookies: string[] = [], extra: Record<string, string> = {}): Response {
  const headers = new Headers({ "content-type": "application/json", ...extra });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * 401 signed_out, clearing the session cookie only when the request sent one.
 * A clear can still delete a newer session, when a stale request lands after
 * a fresh sign-in in another tab, so it is never sent unprompted.
 */
const signedOut = (req: Request) =>
  jsonResponse({ error: "signed_out" }, 401, readCookie(req, SESSION_COOKIE) === null ? [] : [clearCookie(SESSION_COOKIE)]);
const refreshNeeded = () => jsonResponse({ error: "session_refresh_needed" }, 401);
const unavailable = () => jsonResponse({ error: "upstream_unavailable" }, 502);

const limits = (cfg: BffConfig) => ({ maxHours: cfg.maxHours, idleMinutes: cfg.idleMinutes });

/** The absolute end of the session: maxHours after sign-in, or the Access token's expiry if sooner. */
function sessionEnd(session: Session, cfg: BffConfig): number {
  const end = session.created_at + cfg.maxHours * 3600;
  return session.cf_access_exp === undefined ? end : Math.min(end, session.cf_access_exp);
}

async function sessionCookie(s: Sealer, session: Session, cfg: BffConfig): Promise<string> {
  return cookieHeader(SESSION_COOKIE, await s.seal(SESSION_COOKIE, session), sessionEnd(session, cfg) - cfg.now());
}

/**
 * The /api/v1 path for the part of a /bff/api/ path after the prefix, still
 * percent-encoded, or null when it isn't on the allowlist. Anything encoded,
 * dotted or with an empty segment is refused before matching, so no spelling
 * of a path can reach a route the allowlist doesn't name.
 */
export function apiPath(raw: string): string | null {
  if (raw.includes("%") || raw.includes("..") || raw.includes("//") || raw.includes("\\")) return null;
  if (raw.split("/").some((segment) => segment === "")) return null;
  return ALLOWLIST.some((re) => re.test(raw)) ? `/api/v1/${raw}` : null;
}

/** GET /bff/session */
export async function handleSession(req: Request, cfg: BffConfig): Promise<Response> {
  const s = await sealer(cfg.secret);
  const session = await readSession(req, s);
  const now = cfg.now();
  if (!session || sessionState(session, now, limits(cfg)) === "expired") {
    const cookies = readCookie(req, SESSION_COOKIE) === null ? [] : [clearCookie(SESSION_COOKIE)];
    return jsonResponse({ signed_in: false }, 200, cookies);
  }
  // A session due for refresh still counts as signed in: the page refreshes
  // when the proxy asks it to.
  const cookies =
    now - session.last_seen >= TOUCH_INTERVAL_SEC ? [await sessionCookie(s, { ...session, last_seen: now }, cfg)] : [];
  return jsonResponse({ signed_in: true, expires_at: sessionEnd(session, cfg), data_key: session.data_key }, 200, cookies);
}

type GrantResult =
  | { kind: "ok"; access_token: string; expires_in: number; refresh_token?: string }
  | { kind: "invalid_grant" }
  | { kind: "refused" }
  | { kind: "unavailable" };

/**
 * One refresh-token grant. The library authenticates the client from the Basic
 * header like any /token call, then answers 400 invalid_grant for a token that
 * is neither the grant's current nor its previous one, or a grant that is gone
 * (handleRefreshTokenGrant in oauth-provider.js, lines 3683 and 3689). A
 * success always rotates the refresh token (lines 3789-3795 and 3823); a
 * response without one keeps the old token. Only 400 and 401 are refusals:
 * a 429, a 5xx or a redirect says nothing about the grant.
 */
async function refreshGrant(cfg: BffConfig, device: Device, refreshToken: string): Promise<GrantResult> {
  let res: Response;
  try {
    res = await cfg.upstream("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(device) },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (res.status !== 200 && res.status !== 400 && res.status !== 401) {
    await res.body?.cancel();
    return { kind: "unavailable" };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status !== 200) return body?.error === "invalid_grant" ? { kind: "invalid_grant" } : { kind: "refused" };
  const { access_token, expires_in, refresh_token } = body ?? {};
  if (typeof access_token !== "string" || access_token === "" || !Number.isFinite(expires_in)) return { kind: "unavailable" };
  return {
    kind: "ok",
    access_token,
    expires_in: expires_in as number,
    ...(typeof refresh_token === "string" && refresh_token !== "" ? { refresh_token } : {}),
  };
}

/** POST /bff/session/refresh */
export async function handleRefresh(req: Request, cfg: BffConfig): Promise<Response> {
  if (!csrfOk(req, cfg)) return new Response(null, { status: 403 });
  const s = await sealer(cfg.secret);
  const session = await readSession(req, s);
  const state = session ? sessionState(session, cfg.now(), limits(cfg)) : "expired";
  if (!session || state === "expired") return signedOut(req);
  // Not due yet, most likely another tab's refresh already landed: nothing to do.
  if (state === "valid") return new Response(null, { status: 204 });
  const device = await readDevice(req, s, cfg);
  if (!device) return signedOut(req);

  let result = await refreshGrant(cfg, device, session.refresh_token);
  if (result.kind === "invalid_grant") {
    // Once more after a second, before declaring the session over (the
    // design's grace-window retry). It presents the same token, so it recovers
    // a refusal from a grant record that hadn't caught up yet, not a token
    // that two later refreshes have superseded.
    await cfg.sleep(REFRESH_RETRY_DELAY_MS);
    result = await refreshGrant(cfg, device, session.refresh_token);
  }
  if (result.kind === "unavailable") return unavailable();
  if (result.kind !== "ok") return signedOut(req);

  // The refresh response carries no cf_access_token (the OAuth front adds one
  // only at code redemption: workers/server/src/hosts/shared/oauth.ts, lines
  // 94-98), so the Access token and its expiry carry over with the rest.
  const now = cfg.now();
  const fresh: Session = {
    ...session,
    access_token: result.access_token,
    access_exp: now + result.expires_in,
    refresh_token: result.refresh_token ?? session.refresh_token,
    last_seen: now,
  };
  if (!isSession(fresh)) return unavailable();
  return new Response(null, { status: 204, headers: { "set-cookie": await sessionCookie(s, fresh, cfg) } });
}

/** GET /bff/api/<path> → GET /api/v1/<path> */
export async function handleApi(req: Request, cfg: BffConfig): Promise<Response> {
  const url = new URL(req.url);
  const target = url.pathname.startsWith(API_PREFIX) ? apiPath(url.pathname.slice(API_PREFIX.length)) : null;
  if (!target) return jsonResponse({ error: "not_found" }, 404);
  if (req.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, [], { allow: "GET" });

  const s = await sealer(cfg.secret);
  const session = await readSession(req, s);
  const state = session ? sessionState(session, cfg.now(), limits(cfg)) : "expired";
  if (!session || state === "expired") return signedOut(req);
  if (state === "refresh") return refreshNeeded();

  const headers = new Headers({ authorization: `Bearer ${session.access_token}` });
  if (session.cf_access_token) headers.set("cf-access-token", session.cf_access_token);
  let res: Response;
  try {
    res = await cfg.upstream(target + url.search, { method: "GET", headers });
  } catch {
    return unavailable();
  }
  if (res.status === 401) {
    await res.body?.cancel();
    return refreshNeeded();
  }
  if (res.status >= 300 && res.status < 400) {
    // Most likely Access's login page. A Location to follow would take the
    // page off this origin, so it isn't passed on.
    await res.body?.cancel();
    return jsonResponse({ error: "upstream_redirect" }, 502);
  }
  const out = new Headers();
  for (const name of PASSED_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  const bytes = target.startsWith("/api/v1/attachments/") || target.startsWith("/api/v1/theme-images/");
  if (bytes && !res.ok) keepType(out, ["application/json"]); // the server's contract errors
  else if (target.startsWith("/api/v1/attachments/")) asDownload(out, ATTACHMENT_TYPES);
  else if (target.startsWith("/api/v1/theme-images/")) keepType(out, RASTER_TYPES);
  return new Response(res.body, { status: res.status, headers: out });
}

// Attachment and theme-image bytes are anyone's content, served from the app's
// origin, where script-src 'self' applies. Kept as script, HTML or SVG they'd
// be a same-origin script source or an inline page, so only inert types keep
// their Content-Type, and attachments always download. (headers.ts also gives
// every /bff/api response a sandbox CSP.)
const RASTER_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
const ATTACHMENT_TYPES = [...RASTER_TYPES, "application/pdf"];

function keepType(headers: Headers, allowed: string[]): void {
  const media = headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!allowed.includes(media)) headers.set("content-type", "application/octet-stream");
}

function asDownload(headers: Headers, allowed: string[]): void {
  keepType(headers, allowed);
  // Keep the parameters (the filename) and replace the disposition type.
  const upstream = headers.get("content-disposition");
  const semi = upstream?.indexOf(";") ?? -1;
  const params = upstream && semi >= 0 ? upstream.slice(semi + 1).trim() : "";
  headers.set("content-disposition", /filename/i.test(params) ? `attachment; ${params}` : "attachment");
}
