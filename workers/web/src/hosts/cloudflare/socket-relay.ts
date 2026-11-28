// The push socket's relay on the Cloudflare host: the page's /bff/socket on one
// side, the server's /api/v1/sync/socket on the other (docs/SYNC-API.md
// section 7). authorizeSocket (bff/socket.ts) has already decided the upgrade
// may open and built the only headers that go upstream; this file connects and
// pipes. The Workers WebSocket API is injected (SocketRuntime) so the relay
// runs in Node tests, where neither WebSocketPair nor a 101 Response exists.
//
// The page always gets a 101, even when the upstream refuses: the refusal
// arrives as a close code (4001 check the session, 1011 anything else), so the
// page's reconnect logic has one place to look.

/** The part of a Workers WebSocket the relay uses. */
export interface RelaySocket {
  accept(): void;
  send(data: string | ArrayBuffer): void;
  close(code: number, reason: string): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (e: { code: number; reason?: string }) => void): void;
  addEventListener(type: "error", fn: (e: unknown) => void): void;
}

export type SocketRuntime = {
  /** A new pair: [the end the page gets, the end the relay holds]. */
  pair(): [RelaySocket, RelaySocket];
  /** The 101 that hands the page its end. Nothing else goes on it: no Set-Cookie, no other header. */
  upgraded(client: RelaySocket): Response;
};

export type SocketOpen = { path: string; headers: Headers };

/** Check the session: the page refreshes or signs out (global constraints, close codes). */
const SESSION_CLOSE = 4001;
const FAILED_CLOSE = 1011;
const POLICY_CLOSE = 1008;
/** The close frame's reason is at most 123 bytes of UTF-8 (RFC 6455 section 5.5). */
const MAX_REASON_BYTES = 123;
/** The page sends only this (SYNC-API 7.1), which the server's hibernation auto-response answers. */
const PING = "ping";

/**
 * A code the relay may pass on: the 1000-1003 normal ones and the 3000-4999
 * application range. 1005, 1006 and 1015 are never sent in a frame, and the
 * Workers runtime throws on them, so they and the rest become 1011.
 */
function forwardable(code: unknown): number {
  return typeof code === "number" && Number.isInteger(code) && ((code >= 1000 && code <= 1003) || (code >= 3000 && code <= 4999))
    ? code
    : FAILED_CLOSE;
}

function truncateReason(reason: unknown): string {
  if (typeof reason !== "string") return "";
  const enc = new TextEncoder();
  if (enc.encode(reason).length <= MAX_REASON_BYTES) return reason;
  let out = "";
  let bytes = 0;
  for (const ch of reason) {
    const n = enc.encode(ch).length;
    if (bytes + n > MAX_REASON_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out;
}

// Server messages are small JSON (hello, changed, reauth); the length check
// keeps the relay from parsing anything large.
function isReauth(data: unknown): boolean {
  if (typeof data !== "string" || data.length > 256) return false;
  try {
    const msg: unknown = JSON.parse(data);
    return typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "reauth";
  } catch {
    return false;
  }
}

/**
 * Opens the upstream socket and relays it to a new pair's client end. `upstream`
 * is the host's binding-or-fetch; the request carries `open.headers` only and
 * never follows a redirect, which would carry the bearer token elsewhere.
 */
export async function relay(
  open: SocketOpen,
  upstream: (req: Request) => Promise<Response>,
  serverOrigin: string,
  runtime: SocketRuntime,
): Promise<Response> {
  let up: RelaySocket | null = null;
  let refusal = FAILED_CLOSE;
  try {
    const res = await upstream(new Request(serverOrigin + open.path, { headers: open.headers, redirect: "manual" }));
    const ws = (res as Response & { webSocket?: RelaySocket | null }).webSocket;
    if (res.status === 101 && ws) up = ws;
    else {
      if (res.status === 401 || res.status === 403) refusal = SESSION_CLOSE;
      console.warn(JSON.stringify({ level: "warn", event: "socket_upstream_refused", status: res.status }));
      void res.body?.cancel().catch(() => {});
    }
  } catch (err) {
    console.warn(
      JSON.stringify({ level: "warn", event: "socket_upstream_failed", error: err instanceof Error ? err.message : String(err) }),
    );
  }

  const [client, browser] = runtime.pair();
  browser.accept();
  if (!up) {
    browser.close(refusal, refusal === SESSION_CLOSE ? "session" : "upstream");
    return runtime.upgraded(client);
  }
  const upstreamWs = up;
  upstreamWs.accept();

  // Each socket is closed once. A close event from a socket still gets one
  // close() back, which completes the closing handshake on that side.
  const closed = new Set<RelaySocket>();
  const close = (ws: RelaySocket, code: number, reason: string) => {
    if (closed.has(ws)) return;
    closed.add(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed by the runtime.
    }
  };
  const closeBoth = (code: number, reason: string) => {
    close(browser, code, reason);
    close(upstreamWs, code, reason);
  };
  const live = () => !closed.has(browser) && !closed.has(upstreamWs);
  const send = (ws: RelaySocket, data: unknown) => {
    try {
      ws.send(data as string | ArrayBuffer);
      return true;
    } catch {
      closeBoth(FAILED_CLOSE, "upstream");
      return false;
    }
  };

  upstreamWs.addEventListener("message", (e) => {
    if (!live()) return;
    if (!send(browser, e.data)) return;
    if (isReauth(e.data)) {
      close(browser, SESSION_CLOSE, "session");
      close(upstreamWs, 1000, "session");
    }
  });
  // A message of 64 bytes or more can't equal "ping", so the exact comparison
  // is also the size limit; binary never matches.
  browser.addEventListener("message", (e) => {
    if (!live()) return;
    if (e.data === PING) send(upstreamWs, PING);
    else closeBoth(POLICY_CLOSE, "policy");
  });
  for (const ws of [upstreamWs, browser]) {
    ws.addEventListener("close", (e) => closeBoth(forwardable(e.code), truncateReason(e.reason)));
    ws.addEventListener("error", () => closeBoth(FAILED_CLOSE, "error"));
  }

  return runtime.upgraded(client);
}
