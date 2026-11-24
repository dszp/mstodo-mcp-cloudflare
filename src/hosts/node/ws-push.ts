// Push sockets on the Node host (docs/SYNC-API.md section 7.3). One process
// serves every client (single-instance.ts enforces it), so the hub is an
// in-memory set; no cross-process fan-out.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChangeNotifier } from "../../core/ports";
import { log } from "../../core/log";

export const SOCKET_PATH = "/api/v1/sync/socket";
// The protocol only carries pings.
const MAX_CLIENT_FRAME = 1024;
// Never longer than this, whatever the token says (section 18.7).
const MAX_SOCKET_LIFETIME_MS = 24 * 3_600_000;

// What the upgrade's authentication established. `exp` is the access token's
// expiry (epoch ms); the socket ends then and the client reconnects with a
// fresh token.
export interface SocketGrant {
  exp: number;
  client?: string;
}

export class SocketHub implements ChangeNotifier {
  #sockets = new Map<WebSocket, NodeJS.Timeout>();

  get size(): number {
    return this.#sockets.size;
  }

  announce(cursor: string): void {
    const msg = JSON.stringify({ type: "changed", cursor });
    for (const ws of this.#sockets.keys()) ws.send(msg);
  }

  closeAll(): void {
    for (const ws of [...this.#sockets.keys()]) this.#endForReauth(ws);
  }

  // Serves the socket path's upgrades on `server`. `authorize` runs the same
  // checks as any /api/v1 request (audience-checked token validation plus the
  // grant gate) and returns null to refuse; the upgrade never reaches the
  // fetch-style handler, so the request rewrite and body caps don't apply.
  attach(
    server: Pick<Server, "on">,
    opts: { authorize: (req: IncomingMessage) => Promise<SocketGrant | null>; cursor: () => string | Promise<string> },
  ): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== SOCKET_PATH) return refuse(socket, 404, "Not Found");
      opts.authorize(req).then(
        async (grant) => {
          if (!grant || !(grant.exp > Date.now())) return refuse(socket, 401, "Unauthorized");
          const cursor = await opts.cursor();
          wss.handleUpgrade(req, socket, head, (ws) => this.#add(ws, grant, cursor));
        },
        (e) => {
          log.warn("sync_socket_auth_failed", { error: String(e) });
          refuse(socket, 503, "Service Unavailable");
        },
      );
    });
  }

  #add(ws: WebSocket, grant: SocketGrant, cursor: string): void {
    const ttl = Math.min(grant.exp - Date.now(), MAX_SOCKET_LIFETIME_MS);
    const timer = setTimeout(() => this.#endForReauth(ws), Math.max(0, ttl));
    timer.unref();
    this.#sockets.set(ws, timer);
    ws.on("message", (data, isBinary) => {
      if (!isBinary && data.toString() === "ping") ws.send("pong");
    });
    ws.on("close", () => this.#drop(ws));
    ws.on("error", () => this.#drop(ws));
    ws.send(JSON.stringify({ type: "hello", cursor }));
  }

  #drop(ws: WebSocket): void {
    const t = this.#sockets.get(ws);
    if (t) clearTimeout(t);
    this.#sockets.delete(ws);
  }

  #endForReauth(ws: WebSocket): void {
    this.#drop(ws);
    try {
      ws.send(JSON.stringify({ type: "reauth" }));
      ws.close(4001, "reauth");
    } catch {
      // already closed
    }
  }
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
