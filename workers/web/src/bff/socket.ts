// Who may open the push socket, /bff/socket (docs/SYNC-API.md section 7). The
// host relays an accepted upgrade to the server's /api/v1/sync/socket; this
// file only decides, so it stays free of any runtime's WebSocket API.
//
// A browser WebSocket can't set headers, so the X-Potem check that guards the
// other state-changing routes (csrfOk) can't apply. Origin is what stops
// cross-site WebSocket hijacking instead: a page on another origin can open
// wss://<web host>/bff/socket and the browser attaches the session cookie,
// but it always sends that page's Origin. The comparison is csrfOk's: exact
// equality with the web origin, and a missing Origin is refused.
//
// Checks run cheapest first, and Origin before the session, so a foreign page
// learns nothing about the session state. A refused upgrade never reaches the
// server.

import { authorize, jsonResponse } from "./api.ts";
import { withSecurityHeaders } from "./headers.ts";
import type { BffConfig } from "./upstream.ts";

export const BFF_SOCKET_PATH = "/bff/socket";
/** The server's socket (SOCKET_PATH in workers/server/src/hosts/shared/oauth.ts). */
export const UPSTREAM_SOCKET_PATH = "/api/v1/sync/socket";

export type SocketDecision =
  | { kind: "open"; path: typeof UPSTREAM_SOCKET_PATH; headers: Headers }
  | { kind: "refuse"; response: Response };

/**
 * The refusal for a request that isn't a WebSocket upgrade by GET, or null.
 * No session is read. router.ts uses it to tell an upgrade, which it leaves
 * to the host, from a request it answers itself.
 */
export function upgradeRefusal(req: Request): Response | null {
  if (req.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, [], { allow: "GET" });
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonResponse({ error: "upgrade_required" }, 426, [], { upgrade: "websocket" });
  }
  return null;
}

/**
 * Whether this request may open the socket. `open` carries the only headers
 * the upstream upgrade may send: Upgrade, Authorization and, when the session
 * has one, cf-access-token. A refusal carries the security headers and
 * no-store, and clears the session cookie only for signed_out with a cookie
 * sent. The session cookie is never rewritten here.
 */
export async function authorizeSocket(req: Request, cfg: BffConfig): Promise<SocketDecision> {
  const refuse = (res: Response): SocketDecision => ({ kind: "refuse", response: withSecurityHeaders(res, cfg, BFF_SOCKET_PATH) });
  const notUpgrade = upgradeRefusal(req);
  if (notUpgrade) return refuse(notUpgrade);
  if (req.headers.get("origin") !== cfg.webOrigin) return refuse(jsonResponse({ error: "forbidden" }, 403));
  const headers = await authorize(req, cfg);
  if (headers instanceof Response) return refuse(headers);
  headers.set("upgrade", "websocket");
  return { kind: "open", path: UPSTREAM_SOCKET_PATH, headers };
}
