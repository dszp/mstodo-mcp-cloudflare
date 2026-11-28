// The page's side of the BFF session (workers/web/src/bff/api.ts): reading it,
// refreshing it, signing out, and telling the other tabs.
//
// Refresh is serialized twice. Within the page, concurrent callers share one
// in-flight POST. Across tabs, the POST runs under the Web Lock
// "potem-refresh", so a second tab waits for the first and then sends a POST
// the BFF answers as a no-op (the session is no longer due), or nothing, if
// the page signed out while it waited. Two tabs
// rotating from the same refresh token at once could leave the browser
// holding a superseded one (the BFF's comment explains how).
//
// The page also ends the session on its own, without the network: /bff/session
// says when the session ends (expires_at) and how long it may sit idle
// (idle_minutes), and watchSession signs out at whichever comes first, even
// offline or after a back-forward cache restore. Activity is shared across
// tabs on the same channel, since the BFF's idle timer is one per browser. It
// also refreshes the access token at refresh_at, so a plain navigation (an
// attachment download) never meets an expired one.
//
// Signing out happens once per page: the mirror is cleared and sealed (no
// later page applies), the other tabs are
// told on BroadcastChannel("potem-session"), and the listeners run. A tab that
// hears it from another does the same without posting again. A page that
// signed out stays signed out: signing in again is a navigation to
// /auth/login, which loads a fresh page.

import type { MirrorStore } from "../sync/store.ts";
import { throttle } from "./throttle.ts";

/** GET /bff/session. Times are epoch seconds on the BFF's clock; `now` is that clock when it answered. */
export type SessionInfo =
  | { signed_in: false }
  | { signed_in: true; expires_at: number; idle_minutes: number; refresh_at: number; now: number; data_key: string };

/** The session's deadlines in this device's epoch milliseconds, and the idle limit. */
export type SessionLimits = { endsAt: number; refreshAt: number; idleMs: number };

/** The part of navigator.locks the refresh uses. */
export interface LockRequester {
  request<T>(name: string, cb: () => Promise<T>): Promise<T>;
}

export interface SessionClient {
  /**
   * GET /bff/session, under the same cross-tab lock as a refresh: the BFF can
   * rewrite the cookie (last_seen) while answering it. Signed out runs the
   * signed-out flow; a server error throws.
   */
  current(): Promise<SessionInfo>;
  /** The deadlines from the last signed-in current(), or null before one. */
  limits(): SessionLimits | null;
  /** Calls `cb` whenever limits() changes. Returns an unsubscribe. */
  onLimits(cb: () => void): () => void;
  /**
   * current(), then a refresh when the access token is due. true when the
   * session is usable. Throws when the BFF can't be reached.
   */
  ensureFresh(): Promise<boolean>;
  /** When the person last used this page or another tab, in epoch milliseconds. */
  readonly lastActivity: number;
  /**
   * When this page last moved the BFF's idle timer: a signed-in GET
   * /bff/session or a refresh answered 204. Epoch milliseconds.
   */
  readonly lastContact: number;
  /** Records activity now and tells the other tabs. */
  touch(): void;
  /**
   * POST /bff/session/refresh, shared by concurrent callers. true when the
   * session is usable (refreshed, or not yet due); false when it is over, after
   * running the signed-out flow. Any other answer (502 upstream_unavailable,
   * a network error) throws: the session may still be fine.
   */
  refreshOnce(opts?: { force?: boolean }): Promise<boolean>;
  /** POST /auth/logout, then the signed-out flow. Throws, still signed in, when the server refuses. */
  logout(): Promise<void>;
  /** Runs the signed-out flow; later calls do nothing. */
  markSignedOut(): void;
  readonly signedOut: boolean;
  onSignedOut(cb: () => void): () => void;
}

export interface SessionOptions {
  store: MirrorStore;
  /** navigator.locks; null runs without the cross-tab lock. */
  locks?: LockRequester | null;
  /** The potem-session channel; null when there is none. */
  channel?: BroadcastChannel | null;
}

const SIGNED_OUT_MESSAGE = { type: "signed_out" } as const;
const ACTIVITY_MESSAGE = { type: "activity" } as const;
/** Activity is told to the other tabs at most this often. */
const ACTIVITY_BROADCAST_MS = 5_000;
const LOCK = "potem-refresh";
const CSRF_HEADER = { "x-potem": "1" };

function defaultLocks(): LockRequester | null {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  return locks ? { request: (name, cb) => locks.request(name, cb) } : null;
}

function defaultChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "function" ? new BroadcastChannel("potem-session") : null;
}

export function createSessionClient(fetchFn: typeof fetch, opts: SessionOptions): SessionClient {
  const { store } = opts;
  const locks = opts.locks === undefined ? defaultLocks() : opts.locks;
  const channel = opts.channel === undefined ? defaultChannel() : opts.channel;
  const listeners = new Set<() => void>();
  const inflight = new Map<boolean, Promise<boolean>>();
  const limitListeners = new Set<() => void>();
  let signedOut = false;
  let limits: SessionLimits | null = null;
  let lastActivity = Date.now();
  let lastBroadcast = 0;
  let lastContact = 0;

  const underLock = <T,>(cb: () => Promise<T>): Promise<T> => (locks ? locks.request(LOCK, cb) : cb());

  function endSession(broadcast: boolean): void {
    if (signedOut) return;
    signedOut = true;
    store.clear();
    store.seal();
    if (broadcast) channel?.postMessage(SIGNED_OUT_MESSAGE);
    for (const cb of [...listeners]) cb();
  }

  channel?.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as { type?: unknown } | null;
    if (typeof data !== "object" || data === null) return;
    if (data.type === SIGNED_OUT_MESSAGE.type) endSession(false);
    else if (data.type === ACTIVITY_MESSAGE.type) lastActivity = Date.now();
  });

  function setLimits(info: Extract<SessionInfo, { signed_in: true }>, receivedAt: number): void {
    // The BFF's times converted to this device's clock, so a skewed clock
    // neither ends the session early nor refreshes in a loop.
    const offsetMs = info.now * 1000 - receivedAt;
    limits = {
      endsAt: info.expires_at * 1000 - offsetMs,
      refreshAt: info.refresh_at * 1000 - offsetMs,
      idleMs: info.idle_minutes * 60_000,
    };
    for (const cb of [...limitListeners]) cb();
  }

  async function post(force: boolean): Promise<boolean> {
    const headers: Record<string, string> = force ? { ...CSRF_HEADER, "x-potem-force": "1" } : CSRF_HEADER;
    const res = await fetchFn("/bff/session/refresh", { method: "POST", headers });
    if (res.status === 204) {
      lastContact = Date.now();
      return true;
    }
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (res.status === 401 && body?.error === "signed_out") {
      endSession(true);
      return false;
    }
    throw new Error(`session refresh failed: ${res.status}${typeof body?.error === "string" ? ` ${body.error}` : ""}`);
  }

  async function current(): Promise<SessionInfo> {
    const res = await underLock(() => fetchFn("/bff/session"));
    if (!res.ok) throw new Error(`session check failed: ${res.status}`);
    const info = (await res.json()) as SessionInfo;
    if (info.signed_in !== true) {
      endSession(true);
      return { signed_in: false };
    }
    lastContact = Date.now();
    setLimits(info, Date.now());
    return info;
  }

  function refreshOnce({ force = false } = {}): Promise<boolean> {
    if (signedOut) return Promise.resolve(false);
    let p = inflight.get(force);
    if (!p) {
      p = underLock(() => (signedOut ? Promise.resolve(false) : post(force))).finally(() => inflight.delete(force));
      inflight.set(force, p);
    }
    return p;
  }

  return {
    current,
    refreshOnce,

    limits: () => limits,

    onLimits(cb) {
      limitListeners.add(cb);
      return () => limitListeners.delete(cb);
    },

    async ensureFresh() {
      const info = await current();
      if (!info.signed_in) return false;
      return Date.now() >= limits!.refreshAt ? refreshOnce() : true;
    },

    get lastActivity() {
      return lastActivity;
    },

    get lastContact() {
      return lastContact;
    },

    touch() {
      lastActivity = Date.now();
      if (lastActivity - lastBroadcast < ACTIVITY_BROADCAST_MS) return;
      lastBroadcast = lastActivity;
      channel?.postMessage(ACTIVITY_MESSAGE);
    },

    async logout() {
      const res = await fetchFn("/auth/logout", { method: "POST", headers: CSRF_HEADER });
      if (!res.ok) throw new Error(`sign-out failed: ${res.status}`);
      endSession(true);
    },

    markSignedOut: () => endSession(true),

    get signedOut() {
      return signedOut;
    },

    onSignedOut(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const ACTIVITY_INTERVAL_MS = 60_000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
/** The soonest a refresh is tried again after one that left refresh_at in the past. */
const REFRESH_RETRY_MS = 30_000;
/** How long a page that became visible waits for other tabs' queued messages before its idle check. */
const VISIBLE_SETTLE_MS = 250;

type WatchedSession = Pick<
  SessionClient,
  | "current"
  | "refreshOnce"
  | "limits"
  | "onLimits"
  | "lastActivity"
  | "lastContact"
  | "touch"
  | "markSignedOut"
  | "signedOut"
>;

/**
 * Runs the session's clock while the page is open:
 *
 * - Signs out at the session's end or after idle_minutes without activity,
 *   on a timer and again whenever the page becomes visible or comes back from
 *   the back-forward cache (timers stall while a device sleeps). No request.
 * - Refreshes the access token at refresh_at, then reads the session again
 *   for the next refresh_at, but only after activity since the page last
 *   moved the BFF's idle timer: a refresh moves it too, and an unattended page
 *   that refreshed would keep the BFF's session alive past the idle limit.
 * - Keeps the BFF's idle timer alive: pointer, wheel, touch and keyboard input
 *   and the page becoming visible (250 ms after, see onVisible) count as
 *   activity, and GET /bff/session (the only request that moves the BFF's
 *   timer) is sent at most once a minute; the page's own check on load counts
 *   as the first.
 *
 * Every event checks the deadlines before it counts as activity, so a tab
 * reopened after the idle limit signs out. Returns a function that stops it.
 */
export function watchSession(
  session: WatchedSession,
  env: {
    target: EventTarget;
    doc: EventTarget & { visibilityState: DocumentVisibilityState };
    /** Receives pageshow. */
    win: EventTarget;
  },
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let refreshing = false;
  let lastRefreshTry = -Infinity;

  const checkServer = throttle(() => {
    session.current().catch((e: unknown) => console.warn("session check failed", e));
  }, ACTIVITY_INTERVAL_MS);

  /** Signs out when a deadline has passed, refreshes when one is due, then re-arms. */
  function check(): void {
    clearTimeout(timer);
    if (stopped || session.signedOut) return;
    const limits = session.limits();
    if (!limits) return;
    const now = Date.now();
    if (now >= limits.endsAt || now - session.lastActivity >= limits.idleMs) {
      session.markSignedOut();
      return;
    }
    // Without activity since the last contact, no refresh: the next activity
    // event runs this check again.
    const active = session.lastActivity > session.lastContact;
    const refreshAt = active ? Math.max(limits.refreshAt, lastRefreshTry + REFRESH_RETRY_MS) : Infinity;
    if (now >= refreshAt && !refreshing) {
      refreshing = true;
      lastRefreshTry = now;
      session
        .refreshOnce()
        .then((ok) => (ok ? session.current() : undefined))
        .catch((e: unknown) => console.warn("session refresh failed", e))
        .finally(() => {
          refreshing = false;
          check();
        });
      return;
    }
    const next = Math.min(limits.endsAt, session.lastActivity + limits.idleMs, refreshing ? Infinity : refreshAt);
    timer = setTimeout(check, Math.max(0, next - now));
  }

  const onActivity = () => {
    check(); // with the old activity time: a deadline that passed meanwhile signs out
    if (session.signedOut) return;
    session.touch();
    checkServer();
    check(); // re-armed for the new idle deadline, and a refresh that waited on activity
  };
  // A tab the browser froze while hidden gets the other tabs' queued
  // activity messages just after visibilitychange. Checking at once would
  // sign it out on an idle deadline that activity elsewhere already moved,
  // so the check waits a moment for them.
  let visibleTimer: ReturnType<typeof setTimeout> | undefined;
  const onVisible = () => {
    clearTimeout(visibleTimer);
    if (env.doc.visibilityState !== "visible") return;
    visibleTimer = setTimeout(() => {
      if (!stopped && env.doc.visibilityState === "visible") onActivity();
    }, VISIBLE_SETTLE_MS);
  };
  const onPageShow = (e: Event) => {
    if ((e as PageTransitionEvent).persisted) check();
  };

  for (const type of ACTIVITY_EVENTS) env.target.addEventListener(type, onActivity, { passive: true });
  env.doc.addEventListener("visibilitychange", onVisible);
  env.win.addEventListener("pageshow", onPageShow);
  const stopLimits = session.onLimits(check);
  check();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(visibleTimer);
    stopLimits();
    for (const type of ACTIVITY_EVENTS) env.target.removeEventListener(type, onActivity);
    env.doc.removeEventListener("visibilitychange", onVisible);
    env.win.removeEventListener("pageshow", onPageShow);
  };
}
