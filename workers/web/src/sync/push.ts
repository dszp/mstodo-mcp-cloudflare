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
  // Called after the relay closes with 4001, and after three closes in a row
  // without a hello: refresh the session if it is due and say whether it
  // still holds.
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
// How long the client waits for the transport to open, for the hello after
// it opens, and for any message after a ping, before it gives up on the socket.
const LIVENESS_MS = 10_000;
// A socket that stays open this long past its hello resets the backoff.
const STABLE_MS = 30_000;
// This many closes in a row without a hello trigger one session check: a
// refusal before the upgrade (401 session_refresh_needed or signed_out from
// /bff/socket) reaches the page only as a 1006 close.
const NO_HELLO_CHECK_AFTER = 3;
// A second 4001 this soon after the first means the refreshed session is still
// refused, so the reconnect after it waits a backoff instead of going at once.
const REPEAT_4001_MS = 10_000;

// Close codes from the relay (Task 2): 4001 = check the session; 1008 = the
// page sent something other than "ping".
const CLOSE_CHECK_SESSION = 4001;
const CLOSE_POLICY = 1008;
const CLOSE_NORMAL = 1000;
// The client gave up on a socket that went quiet (LIVENESS_MS). 4000 rather
// than 1000 so the relay's and the server's logs can tell it from stop(); a
// browser may send only 1000 or 3000-4999, and the relay forwards 4000.
const CLOSE_TIMEOUT = 4000;

// Connects, reconnects and pings.
//
// - "open" is reported only once a hello arrives: the relay accepts the
//   upgrade before the upstream answers, so an open can be followed at once by
//   a 4001 or 1011 close. The backoff counter resets only once a socket has
//   stayed open 30 s past its hello, so a server that keeps failing, before or
//   just after its hello, is retried at 1, 2, 4, 8, 16, then every 30 s (each
//   ±20 %).
// - Liveness: the transport must open within 10 s of open(), the hello must
//   arrive within 10 s of that, and after each ping some message (the
//   server's "pong" or anything else) must arrive within 10 s. Otherwise the
//   client closes the socket with 4000 and treats it as any other close, so a
//   half-open socket or a relay stuck on its upstream can't leave the page
//   "open" with the poll stopped, or "connecting" forever.
// - A 4001 asks the app to check the session once. Nothing reconnects while
//   the check runs. "ok" reconnects at once, unless the previous 4001 was
//   under 10 s ago; "signed_out" stops; a throw backs off.
// - Three closes in a row without a hello (timeouts included) ask for the
//   same check once, until a hello ends the run: "ok" reconnects after the
//   normal backoff, "signed_out" stops.
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
  let stable: Cancel | null = null;
  // The one liveness deadline, and what meets it.
  let watchdog: Cancel | null = null;
  let awaiting: "open" | "hello" | "message" | null = null;
  let helloSeen = false; // on the current socket
  let closesWithoutHello = 0;
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

  const disarm = () => {
    watchdog = clear(watchdog);
    awaiting = null;
  };

  const arm = (s: SocketLike, what: "open" | "hello" | "message") => {
    disarm();
    awaiting = what;
    watchdog = deps.schedule(() => {
      watchdog = null;
      awaiting = null;
      if (socket !== s) return;
      s.close(CLOSE_TIMEOUT);
      // The browser's close event may take a while, or never come for a
      // half-open socket; onClose clears `socket`, so that event is ignored.
      onClose(s, CLOSE_TIMEOUT);
    }, LIVENESS_MS);
  };

  const schedulePing = (s: SocketLike) => {
    ping = deps.schedule(() => {
      ping = null;
      if (socket !== s || !transportOpen) return;
      // Armed before the send, so an answer can never arrive before the wait.
      if (awaiting === null) arm(s, "message");
      s.send("ping");
      schedulePing(s);
    }, PING_MS);
  };

  // A 4001 reconnects at once on "ok" (the backoff waits only for a repeat
  // within 10 s); a run of closes without a hello always backs off.
  const sessionCheck = (after: "4001" | "no_hello") => {
    let repeat = true;
    if (after === "4001") {
      repeat = recent4001 !== null;
      recent4001 = clear(recent4001);
      recent4001 = deps.schedule(() => {
        recent4001 = null;
      }, REPEAT_4001_MS);
    }

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

  function onClose(s: SocketLike, code: number) {
    if (socket !== s) return;
    socket = null;
    transportOpen = false;
    ping = clear(ping);
    stable = clear(stable);
    disarm();
    setState("closed");
    if (code === CLOSE_CHECK_SESSION) {
      // The check runs now, so this close doesn't add to a run without hello.
      closesWithoutHello = 0;
      sessionCheck("4001");
      return;
    }
    if (!helloSeen) {
      closesWithoutHello += 1;
      if (closesWithoutHello === NO_HELLO_CHECK_AFTER) {
        sessionCheck("no_hello");
        return;
      }
    }
    if (code === CLOSE_POLICY && !loggedPolicy) {
      // The page sent something the relay refuses: a bug in this client.
      loggedPolicy = true;
      deps.log?.("push_policy_close");
    }
    backoff();
  }

  const onMessage = (s: SocketLike, data: unknown) => {
    if (socket !== s) return;
    // Any message answers a ping, "pong" and binary included.
    if (awaiting === "message") disarm();
    if (typeof data !== "string") return;
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
      if (awaiting === "hello") disarm();
      helloSeen = true;
      closesWithoutHello = 0;
      stable = clear(stable);
      stable = deps.schedule(() => {
        stable = null;
        attempt = 0;
      }, STABLE_MS);
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
    helloSeen = false;
    arm(s, "open");
    s.addEventListener("open", () => {
      if (socket !== s) return;
      transportOpen = true;
      arm(s, "hello");
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
    stable = clear(stable);
    disarm();
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
      closesWithoutHello = 0;
      connect();
    },
    stop,
  };
}
