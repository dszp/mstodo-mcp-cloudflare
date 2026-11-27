// How the BFF reaches potem-server, and the configuration every BFF route takes.
// Host-independent: the host supplies the fetch function (a service binding or
// global fetch) through upstreamVia().

import type { Device } from "./session.ts";

/** A request to potem-server. `path` starts with "/"; redirects are never followed. */
export type Upstream = (path: string, init?: RequestInit) => Promise<Response>;

export type BffConfig = {
  /** This Worker's origin, e.g. https://web.example.com. */
  webOrigin: string;
  /** potem-server's origin, e.g. https://server.example.com. */
  serverOrigin: string;
  /** WEB_SESSION_SECRET. */
  secret: string;
  maxHours: number;
  idleMinutes: number;
  upstream: Upstream;
  /** Epoch seconds, like every time in the session record. */
  now(): number;
  random(n: number): Uint8Array;
};

/**
 * An Upstream that sends `serverOrigin + path` through `fetchFn`. The response
 * of a redirect is returned as is: the Access probe needs to see it, and a
 * followed redirect could carry the Authorization header to another host.
 */
export function upstreamVia(serverOrigin: string, fetchFn: (req: Request) => Promise<Response>): Upstream {
  return (path, init) => {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`upstream path must be absolute: ${path}`);
    return fetchFn(new Request(serverOrigin + path, { ...init, redirect: "manual" }));
  };
}

/**
 * HTTP Basic client authentication. The OAuth library form-decodes both halves
 * (parseBasicAuthorizationHeader → decodeFormUrlEncodedComponent in
 * node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js,
 * lines 5264-5291), as RFC 6749 section 2.3.1 requires, so they are encoded here.
 */
export function basicAuth(device: Pick<Device, "client_id" | "client_secret">): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
  return `Basic ${btoa(`${enc(device.client_id)}:${enc(device.client_secret)}`)}`;
}

/**
 * Whether Cloudflare Access is in front of the server's sync API. The anonymous
 * `GET /api/v1/sync/info` probe (docs/SYNC-API.md section 8.1) answers one of:
 * - Access's login redirect, when the edge gate is in front;
 * - 403 {"error":"access_denied"} from the server itself
 *   (packages/core/auth/access.ts, checkAccess and accessRefusalResponse), when
 *   the request skipped the edge, as through a service binding;
 * - 200 {server_id}, when Access is off.
 * Throws when the server can't be reached or answers 5xx (including
 * Access's own 503 access_unavailable / access_misconfigured), so sign-in
 * stops instead of guessing.
 */
export async function serverUsesAccess(upstream: Upstream): Promise<boolean> {
  const res = await upstream("/api/v1/sync/info", { method: "GET" });
  if (res.status >= 500) {
    await res.body?.cancel();
    throw new Error(`access probe answered ${res.status}`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    const location = res.headers.get("location");
    if (!location) return false;
    try {
      return new URL(location).hostname.endsWith(".cloudflareaccess.com");
    } catch {
      return false;
    }
  }
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return body?.error === "access_denied";
  }
  await res.body?.cancel();
  return false;
}
