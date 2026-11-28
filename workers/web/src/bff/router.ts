// Dispatches the BFF's paths: /auth/* (sign-in) and /bff/* (session and API).
// Every response it returns carries the security headers; null hands the
// request to the static assets.

import { handleApi, handleRefresh, handleSession, jsonResponse } from "./api.ts";
import { handleCallback, handleLogin, handleLogout } from "./auth.ts";
import { isBffPath, withSecurityHeaders } from "./headers.ts";
import type { BffConfig } from "./upstream.ts";

type Handler = (req: Request, cfg: BffConfig) => Promise<Response>;

const ROUTES = new Map<string, { method: string; handler: Handler }>([
  ["/auth/login", { method: "GET", handler: handleLogin }],
  ["/auth/callback", { method: "GET", handler: handleCallback }],
  ["/auth/logout", { method: "POST", handler: handleLogout }],
  ["/bff/session", { method: "GET", handler: handleSession }],
  ["/bff/session/refresh", { method: "POST", handler: handleRefresh }],
]);

function dispatch(req: Request, cfg: BffConfig, pathname: string): Promise<Response> {
  // handleApi answers 404 off the allowlist, then 405 for anything but GET.
  if (pathname.startsWith("/bff/api/")) return handleApi(req, cfg);
  const r = ROUTES.get(pathname);
  if (!r) return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
  if (req.method !== r.method) {
    return Promise.resolve(jsonResponse({ error: "method_not_allowed" }, 405, [], { allow: r.method }));
  }
  return r.handler(req, cfg);
}

export async function route(req: Request, cfg: BffConfig): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (!isBffPath(pathname)) return null;
  let res: Response;
  try {
    res = await dispatch(req, cfg, pathname);
  } catch (err) {
    // The path only: the query can carry an authorization code.
    console.error(
      JSON.stringify({ level: "error", event: "bff_unhandled", path: pathname, error: err instanceof Error ? err.message : String(err) }),
    );
    res = jsonResponse({ error: "internal" }, 500);
  }
  return withSecurityHeaders(res, cfg, pathname);
}
