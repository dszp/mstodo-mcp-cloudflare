// The headers every response from the web Worker carries: the BFF's own and
// the static assets'. The Worker runs first on every path, so the host applies
// this to ASSETS responses too.

import type { BffConfig } from "./upstream.ts";

/** Paths whose responses carry session state or API data and must never be cached. */
export const isBffPath = (pathname: string) =>
  pathname === "/auth" || pathname.startsWith("/auth/") || pathname === "/bff" || pathname.startsWith("/bff/");

// Task bodies are untrusted HTML; with a cookie session, script on this origin
// could drive the whole BFF API. No inline script or eval, images only from
// here or data:/blob:, and forms only to here or the server's sign-in pages.
const csp = (serverOrigin: string) =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    `form-action 'self' ${serverOrigin}`,
  ].join("; ");

/**
 * One year of HTTPS-only for this host. No includeSubDomains or preload: the
 * web hostname shares a zone with other hosts, and this must cover only the
 * web Worker's own host.
 */
export const HSTS = "max-age=31536000";

const API_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";

/**
 * A copy of `res` with the security headers set, plus `Cache-Control: no-store`
 * and `Cross-Origin-Resource-Policy: same-origin` on /auth/* and /bff/*.
 * /bff/api/* gets a sandbox CSP instead of the page's. Copied because
 * responses from fetch() and the ASSETS binding have immutable headers.
 */
export function withSecurityHeaders(res: Response, cfg: BffConfig, pathname: string): Response {
  const headers = new Headers(res.headers);
  // API responses are data, never a page: a proxied attachment opened
  // directly runs nothing, and no other origin may frame it.
  headers.set("content-security-policy", pathname.startsWith("/bff/api/") ? API_CSP : csp(cfg.serverOrigin));
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("strict-transport-security", HSTS);
  if (isBffPath(pathname)) {
    headers.set("cache-control", "no-store");
    // Session state and API data: no other origin may load them as a resource.
    headers.set("cross-origin-resource-policy", "same-origin");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
