// The page's client for the server's push socket (SYNC-API §7.1), reached
// through the BFF relay at /bff/socket. It tells the app when to pull; it never
// carries data itself. The socket, the timers and randomness are injected, so
// the engine stays free of DOM globals and the tests drive a fake clock.

export type Cancel = () => void;

export type PushState = "connecting" | "open" | "closed";

export interface SocketLike {
  send(s: string): void;
  close(code?: number): void;
  addEventListener(type: "open" | "error", fn: () => void): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (ev: { code: number }) => void): void;
}

export interface PushDeps {
  // A new socket to /bff/socket. It may throw (the app passes `new WebSocket`).
  open(): SocketLike;
  schedule(fn: () => void, ms: number): Cancel;
  // In [0, 1). Spreads reconnects so tabs don't retry in step.
  random(): number;
  // The server's cursor on connect, and after each change.
  onHello(cursor: string): void;
  onChanged(cursor: string): void;
  // Called after the relay closes with 4001: refresh the session if it is due
  // and say whether it still holds.
  onSessionCheck(): Promise<"ok" | "signed_out">;
  onState(s: PushState): void;
  log?(event: string): void;
}

export interface Push {
  start(): void;
  stop(): void;
}

const PING_MS = 30_000;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
// A second 4001 this soon after the first means the refreshed session is still
// refused, so the reconnect after it waits a backoff instead of going at once.
const REPEAT_4001_MS = 10_000;

// Close codes from the relay (Task 2): 4001 = check the session; 1008 = the
// page sent something other than "ping".
const CLOSE_CHECK_SESSION = 4001;
const CLOSE_POLICY = 1008;
const CLOSE_NORMAL = 1000;

// Connects, reconnects and pings.
//
// - "open" is reported only once a hello arrives: the relay accepts the
//   upgrade before the upstream answers, so an open can be followed at once by
//   a 4001 or 1011 close. For the same reason the backoff counter resets on
//   hello, not on open, so a server that keeps failing is retried at 1, 2, 4,
//   8, 16, then every 30 s (each ±20 %).
// - A 4001 asks the app to check the session once. Nothing reconnects while
//   the check runs. "ok" reconnects at once, unless the previous 4001 was
//   under 10 s ago; "signed_out" stops; a throw backs off.
// - stop() closes with 1000 and cancels every timer. Events from a socket or a
//   session check that belong to an earlier run are ignored.
export function createPush(deps: PushDeps): Push {
  let running = false;
  let run = 0; // bumped by start and stop, so late callbacks can tell they are stale
  let socket: SocketLike | null = null;
  let transportOpen = false;
  let attempt = 0;
  let state: PushState | null = null;
  let reconnect: Cancel | null = null;
  let ping: Cancel | null = null;
  let recent4001: Cancel | null = null;
  let loggedPolicy = false;

  const setState = (s: PushState) => {
    if (state === s) return;
    state = s;
    deps.onState(s);
  };

  const clear = (c: Cancel | null): null => {
    c?.();
    return null;
  };

  const backoff = () => {
    const base = Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_CAP_MS);
    if (base < BACKOFF_CAP_MS) attempt += 1;
    const delay = base * (0.8 + 0.4 * deps.random());
    reconnect = clear(reconnect);
    reconnect = deps.schedule(() => {
      reconnect = null;
      connect();
    }, delay);
  };

  const schedulePing = (s: SocketLike) => {
    ping = deps.schedule(() => {
      ping = null;
      if (socket !== s || !transportOpen) return;
      s.send("ping");
      schedulePing(s);
    }, PING_MS);
  };

  const sessionCheck = () => {
    const repeat = recent4001 !== null;
    recent4001 = clear(recent4001);
    recent4001 = deps.schedule(() => {
      recent4001 = null;
    }, REPEAT_4001_MS);

    const mine = run;
    let check: Promise<"ok" | "signed_out">;
    try {
      check = deps.onSessionCheck();
    } catch (err) {
      check = Promise.reject(err);
    }
    check.then(
      (answer) => {
        if (mine !== run) return;
        if (answer === "signed_out") stop();
        else if (repeat) backoff();
        else connect();
      },
      () => {
        if (mine === run) backoff();
      },
    );
  };

  const onClose = (s: SocketLike, code: number) => {
    if (socket !== s) return;
    socket = null;
    transportOpen = false;
    ping = clear(ping);
    setState("closed");
    if (code === CLOSE_CHECK_SESSION) {
      sessionCheck();
      return;
    }
    if (code === CLOSE_POLICY && !loggedPolicy) {
      // The page sent something the relay refuses: a bug in this client.
      loggedPolicy = true;
      deps.log?.("push_policy_close");
    }
    backoff();
  };

  const onMessage = (s: SocketLike, data: unknown) => {
    if (socket !== s || typeof data !== "string") return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const { type, cursor } = msg as { type?: unknown; cursor?: unknown };
    if (typeof cursor !== "string") return; // reauth has none; its 4001 close follows
    if (type === "hello") {
      attempt = 0;
      setState("open");
      deps.onHello(cursor);
    } else if (type === "changed") {
      deps.onChanged(cursor);
    }
  };

  const connect = () => {
    if (!running) return;
    setState("connecting");
    let s: SocketLike;
    try {
      s = deps.open();
    } catch {
      setState("closed");
      backoff();
      return;
    }
    socket = s;
    s.addEventListener("open", () => {
      if (socket !== s) return;
      transportOpen = true;
      ping = clear(ping);
      schedulePing(s);
    });
    s.addEventListener("message", (ev) => onMessage(s, ev.data));
    s.addEventListener("close", (ev) => onClose(s, ev.code));
    // An error event is always followed by a close; the close does the work.
  };

  function stop() {
    if (!running) return;
    running = false;
    run += 1;
    reconnect = clear(reconnect);
    ping = clear(ping);
    recent4001 = clear(recent4001);
    const s = socket;
    socket = null;
    transportOpen = false;
    s?.close(CLOSE_NORMAL);
    setState("closed");
  }

  return {
    start() {
      if (running) return;
      running = true;
      run += 1;
      // A deliberate restart (the tab became visible again) is not a failure.
      attempt = 0;
      connect();
    },
    stop,
  };
}
