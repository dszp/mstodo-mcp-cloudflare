// The push socket's relay on the Cloudflare host: the page's /bff/socket on one
// side, the server's /api/v1/sync/socket on the other (docs/SYNC-API.md
// section 7). authorizeSocket (bff/socket.ts) has already decided the upgrade
// may open and built the only headers that go upstream; this file connects and
// pipes. The Workers WebSocket API is injected (SocketRuntime) so the relay
// runs in Node tests, where neither WebSocketPair nor a 101 Response exists.
//
// The page always gets a 101, even when the upstream refuses or doesn't answer
// within 10 s: the refusal arrives as a close code (4001 check the session,
// 1011 anything else), so the page's reconnect logic has one place to look.
// A relayed socket lasts no longer than the session: at `closeAt` both sides
// close with 4001.

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
  /** A timer; the returned function cancels it. */
  schedule(fn: () => void, ms: number): () => void;
  /** Epoch ms. */
  now(): number;
};

/** closeAt: when the session ends, in epoch ms (authorizeSocket). */
export type SocketOpen = { path: string; headers: Headers; closeAt: number };

/** Check the session: the page refreshes or signs out (global constraints, close codes). */
const SESSION_CLOSE = 4001;
const FAILED_CLOSE = 1011;
const POLICY_CLOSE = 1008;
/** The close frame's reason is at most 123 bytes of UTF-8 (RFC 6455 section 5.5). */
const MAX_REASON_BYTES = 123;
/** The page sends only this (SYNC-API 7.1), which the server's hibernation auto-response answers. */
const PING = "ping";
/** How long the upstream upgrade may take before the page's end closes with 1011. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * A code the relay may pass on: 1000-1003, 1007-1014 and the 3000-4999
 * application range, the codes a close frame may carry. 1004 is reserved, and
 * 1005, 1006 and 1015 are never sent in a frame (the Workers runtime throws on
 * them), so they and the rest become 1011.
 */
function forwardable(code: unknown): number {
  return typeof code === "number" &&
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999))
    ? code
    : FAILED_CLOSE;
}

const TIMED_OUT = Symbol("timed out");

/**
 * An upstream socket that arrives after the relay gave up: accepted only so it
 * can be closed, so the server's side doesn't stay open with nobody on it.
 */
function discardLate(res: Response): void {
  const ws = (res as Response & { webSocket?: RelaySocket | null }).webSocket;
  if (res.status === 101 && ws) {
    try {
      ws.accept();
      ws.close(1000, "timeout");
    } catch {
      // Already gone.
    }
  } else {
    void res.body?.cancel().catch(() => {});
  }
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
  // The page's pair first: once the upstream has answered with a socket,
  // nothing that can throw stands between it and the code that closes it.
  const [client, browser] = runtime.pair();
  browser.accept();

  let up: RelaySocket | null = null;
  let refusal = FAILED_CLOSE;
  // Promise.race rather than an AbortSignal: an abort that lands after the
  // 101 could tear down the socket it just opened.
  let cancelTimeout = () => {};
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    cancelTimeout = runtime.schedule(() => resolve(TIMED_OUT), UPSTREAM_TIMEOUT_MS);
  });
  try {
    const pending = upstream(new Request(serverOrigin + open.path, { headers: open.headers, redirect: "manual" }));
    const res = await Promise.race([pending, timeout]);
    if (res === TIMED_OUT) {
      console.warn(JSON.stringify({ level: "warn", event: "socket_upstream_timeout" }));
      pending.then(discardLate, () => {});
    } else {
      const ws = (res as Response & { webSocket?: RelaySocket | null }).webSocket;
      if (res.status === 101 && ws) up = ws;
      else {
        if (res.status === 401 || res.status === 403) refusal = SESSION_CLOSE;
        console.warn(JSON.stringify({ level: "warn", event: "socket_upstream_refused", status: res.status }));
        void res.body?.cancel().catch(() => {});
      }
    }
  } catch (err) {
    console.warn(
      JSON.stringify({ level: "warn", event: "socket_upstream_failed", error: err instanceof Error ? err.message : String(err) }),
    );
  } finally {
    cancelTimeout();
  }

  if (!up) {
    browser.close(refusal, refusal === SESSION_CLOSE ? "session" : "upstream");
    return runtime.upgraded(client);
  }
  const upstreamWs = up;
  upstreamWs.accept();

  // Each socket is closed once. A close event from a socket still gets one
  // close() back, which completes the closing handshake on that side.
  const closed = new Set<RelaySocket>();
  let cancelSessionEnd = () => {};
  const close = (ws: RelaySocket, code: number, reason: string) => {
    if (closed.has(ws)) return;
    closed.add(ws);
    if (closed.size === 2) cancelSessionEnd();
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
  // The session's end: the page checks the session and signs out, or
  // reconnects if activity has moved the idle timer since this upgrade.
  cancelSessionEnd = runtime.schedule(() => closeBoth(SESSION_CLOSE, "session"), Math.max(0, open.closeAt - runtime.now()));

  return runtime.upgraded(client);
}
