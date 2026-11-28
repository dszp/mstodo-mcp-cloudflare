// The session endpoint, the refresh, and the proxy to the server's sync API
// (docs/SYNC-API.md): reads, plus the one write, POST sync/mutations.
//
// Only GET /bff/session and POST /bff/session/refresh (with sign-in, callback
// and logout in auth.ts) write the session cookie with a new record. A proxied
// /bff/api response never does: the browser sends many of those at once, and
// one that rewrote the cookie from the record it arrived with would put back
// the refresh token a refresh racing alongside had just replaced.
//
// The idle timer's last_seen moves only on user activity: a GET /bff/session
// carrying X-Potem-Activity: 1 (the page sends it after activity, at most
// once a minute) touches it, at most once a minute. A plain read and a
// refresh never do. The page refreshes and reads the session on its own (the
// poll's session_refresh_needed, the push socket's reauth), and if those
// moved last_seen, a page nobody uses would keep its session alive forever.
// A cross-site page can't send the header without a CORS preflight the BFF
// never answers. Likewise the proxy never
// refreshes: near expiry it answers 401 session_refresh_needed, and the page
// sends one POST /bff/session/refresh for all of them. That refresh rotates
// only a session that is due: two tabs refreshing at once would otherwise
// rotate twice from the same token, and if the first response's cookie landed
// last it would hold a token that is neither current nor previous. A forced
// refresh (X-Potem-Force: 1) skips the due check; see handleRefresh.
//
// "oauth-provider.js" below is node_modules/@cloudflare/workers-oauth-provider/
// dist/oauth-provider.js (1.2.3).

import { csrfOk, readDevice, readSession } from "./auth.ts";
import { SESSION_COOKIE, clearCookie, cookieHeader, readCookie } from "./cookies.ts";
import { type Sealer, sealer } from "./seal.ts";
import { type Device, REFRESH_WINDOW_SEC, type Session, isSession, sessionState } from "./session.ts";
import { type BffConfig, basicAuth } from "./upstream.ts";

const API_PREFIX = "/bff/api/";
/** last_seen is rewritten when it is at least this old. */
const TOUCH_INTERVAL_SEC = 60;
const REFRESH_RETRY_DELAY_MS = 1000;
/** The response headers a proxied response keeps. Set-Cookie is never among them. */
const PASSED_HEADERS = ["content-type", "content-disposition", "content-length", "etag", "last-modified"];

const ID = "[A-Za-z0-9_-]{1,128}";
/** The sync API paths the web app reads, after /api/v1/. */
const READ_PATHS = [
  "sync/info",
  "sync/changes",
  "search",
  `tasks/${ID}`,
  `attachments/${ID}`,
  `theme-images/${ID}`,
  "link-rules",
  "lists/excluded",
].map((p) => new RegExp(`^${p}$`));
/** The one sync API path the web app writes to. */
const MUTATIONS_PATH = "sync/mutations";
/**
 * The largest mutation batch passed on: the server's own limit
 * (MUTATIONS_MAX_BYTES in packages/core/api/mutations.ts), so a batch the
 * server would refuse is refused here before it is read in full.
 */
const MUTATIONS_MAX_BYTES = 256 * 1024;

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

export type ApiRoute = { path: string; method: "GET" | "POST" };

/**
 * The /api/v1 path for the part of a /bff/api/ path after the prefix, still
 * percent-encoded, and the one method it takes, or null when the path isn't
 * on the allowlist. Anything encoded, dotted or with an empty segment is
 * refused before matching, so no spelling of a path can reach a route the
 * allowlist doesn't name.
 */
export function apiRoute(raw: string): ApiRoute | null {
  if (raw.includes("%") || raw.includes("..") || raw.includes("//") || raw.includes("\\")) return null;
  if (raw.split("/").some((segment) => segment === "")) return null;
  if (raw === MUTATIONS_PATH) return { path: `/api/v1/${raw}`, method: "POST" };
  return READ_PATHS.some((re) => re.test(raw)) ? { path: `/api/v1/${raw}`, method: "GET" } : null;
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
  const touch = req.headers.get("x-potem-activity") === "1" && now - session.last_seen >= TOUCH_INTERVAL_SEC;
  const cookies = touch ? [await sessionCookie(s, { ...session, last_seen: now }, cfg)] : [];
  // expires_at and the idle limit let the page end the session on its own, even
  // offline; refresh_at lets it refresh before a request has to wait for one.
  // now is the BFF's clock, so the page can compare these times without
  // trusting its own.
  return jsonResponse(
    {
      signed_in: true,
      expires_at: sessionEnd(session, cfg),
      idle_minutes: cfg.idleMinutes,
      // The first second sessionState calls "refresh"; a second earlier the
      // POST would be a no-op 204.
      refresh_at: session.access_exp - REFRESH_WINDOW_SEC + 1,
      now,
      data_key: session.data_key,
    },
    200,
    cookies,
  );
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
  // Not due yet, most likely another tab's refresh already landed: nothing to
  // do. X-Potem-Force rotates anyway: the page sends it when the server keeps
  // refusing an access token the session still counts as valid (a revoked
  // grant, or one the server's epoch check now refuses), which a refresh that
  // waits for access_exp would never fix. The page sends it at most once per
  // failing request, under the same cross-tab lock as any refresh.
  if (state === "valid" && req.headers.get("x-potem-force") !== "1") return new Response(null, { status: 204 });
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
    // last_seen carries over: a refresh is not activity (see the top of this file).
  };
  if (!isSession(fresh)) return unavailable();
  return new Response(null, { status: 204, headers: { "set-cookie": await sessionCookie(s, fresh, cfg) } });
}

/**
 * GET /bff/api/<read path> → GET /api/v1/<read path>, and
 * POST /bff/api/sync/mutations → POST /api/v1/sync/mutations.
 */
export async function handleApi(req: Request, cfg: BffConfig): Promise<Response> {
  const url = new URL(req.url);
  const route = url.pathname.startsWith(API_PREFIX) ? apiRoute(url.pathname.slice(API_PREFIX.length)) : null;
  if (!route) return jsonResponse({ error: "not_found" }, 404);
  if (req.method !== route.method) return jsonResponse({ error: "method_not_allowed" }, 405, [], { allow: route.method });
  return route.method === "POST" ? postMutations(req, cfg, route.path) : getRead(req, cfg, route.path + url.search);
}

/**
 * The session's upstream headers, a fresh Headers holding only Authorization
 * and, when the session has one, cf-access-token; or the 401 that answers
 * instead. Nothing from the browser's request is copied. socket.ts uses it too.
 */
export async function authorize(req: Request, cfg: BffConfig): Promise<Headers | Response> {
  const s = await sealer(cfg.secret);
  const session = await readSession(req, s);
  const state = session ? sessionState(session, cfg.now(), limits(cfg)) : "expired";
  if (!session || state === "expired") return signedOut(req);
  if (state === "refresh") return refreshNeeded();
  const headers = new Headers({ authorization: `Bearer ${session.access_token}` });
  if (session.cf_access_token) headers.set("cf-access-token", session.cf_access_token);
  return headers;
}

/**
 * The upstream call. `replaced` is the BFF's own answer for a network
 * failure, a 401, Access's 403 or a redirect; otherwise `res` is passed on.
 */
async function callUpstream(
  req: Request,
  cfg: BffConfig,
  path: string,
  init: RequestInit,
): Promise<{ res: Response; replaced: null } | { res: null; replaced: Response }> {
  let res: Response;
  try {
    res = await cfg.upstream(path, init);
  } catch {
    return { res: null, replaced: unavailable() };
  }
  if (res.status === 401) {
    await res.body?.cancel();
    return { res: null, replaced: refreshNeeded() };
  }
  if (res.status === 403 && (await accessDenied(res))) {
    // Access refused the Access token the session carries (expired or
    // revoked). Only a new sign-in through /app/signin gets another.
    return { res: null, replaced: signedOut(req) };
  }
  if (res.status >= 300 && res.status < 400) {
    // Most likely Access's login page. A Location to follow would take the
    // page off this origin, so it isn't passed on.
    await res.body?.cancel();
    return { res: null, replaced: jsonResponse({ error: "upstream_redirect" }, 502) };
  }
  return { res, replaced: null };
}

async function getRead(req: Request, cfg: BffConfig, target: string): Promise<Response> {
  const headers = await authorize(req, cfg);
  if (headers instanceof Response) return headers;
  const { res, replaced } = await callUpstream(req, cfg, target, { method: "GET", headers });
  if (replaced) return replaced;
  const out = new Headers();
  for (const name of PASSED_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  // A body the runtime still has to decode (or re-encode) has no fixed length.
  if (res.headers.has("content-encoding")) out.delete("content-length");
  const bytes = target.startsWith("/api/v1/attachments/") || target.startsWith("/api/v1/theme-images/");
  if (bytes && !res.ok) keepType(out, ["application/json"]); // the server's contract errors
  else if (target.startsWith("/api/v1/attachments/")) asDownload(out, ATTACHMENT_TYPES);
  else if (target.startsWith("/api/v1/theme-images/")) keepType(out, RASTER_TYPES);
  return new Response(res.body, { status: res.status, headers: out });
}

/**
 * The write path. The checks run cheapest first, and all of them before the
 * body is read: CSRF (X-Potem and Origin, as for every state-changing BFF
 * route), the media type, the declared length, then the session. The body is
 * then read with the limit enforced on the bytes themselves, because a
 * chunked request has no Content-Length and a request can declare less than
 * it sends. The exact bytes go upstream, never a re-serialization, so the
 * server sees what the page sent.
 */
async function postMutations(req: Request, cfg: BffConfig, target: string): Promise<Response> {
  if (!csrfOk(req, cfg)) return jsonResponse({ error: "forbidden" }, 403);
  const media = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (media !== "application/json") return jsonResponse({ error: "unsupported_media_type" }, 415);
  if (Number(req.headers.get("content-length") ?? 0) > MUTATIONS_MAX_BYTES) return tooLarge();
  const headers = await authorize(req, cfg);
  if (headers instanceof Response) return headers;
  const body = await readCapped(req.body, MUTATIONS_MAX_BYTES);
  if (!body) return tooLarge();

  headers.set("content-type", "application/json");
  const { res, replaced } = await callUpstream(req, cfg, target, { method: "POST", headers, body });
  if (replaced) return replaced;
  // §5.3: the status and the JSON body are what the page acts on. Content-Type
  // is the only header kept, and only as JSON.
  const out = new Headers();
  const type = res.headers.get("content-type");
  if (type !== null) out.set("content-type", type);
  keepType(out, ["application/json"]);
  return new Response(res.body, { status: res.status, headers: out });
}

const tooLarge = () => jsonResponse({ error: "body_too_large", max: MUTATIONS_MAX_BYTES }, 413);

/** The stream's bytes, or null as soon as they pass `max`, cancelling the rest. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Whether a 403 is the server's Access refusal, {"error":"access_denied"}
 * (packages/core/auth/access.ts, accessRefusalResponse). Reads a clone, so the
 * response can still be passed on when it isn't.
 */
async function accessDenied(res: Response): Promise<boolean> {
  const body = (await res.clone().json().catch(() => null)) as { error?: unknown } | null;
  return body?.error === "access_denied";
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
