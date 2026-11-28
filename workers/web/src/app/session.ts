// The page's side of the BFF session (workers/web/src/bff/api.ts): reading it,
// refreshing it, signing out, and telling the other tabs.
//
// Refresh is serialized twice. Within the page, concurrent callers share one
// in-flight POST. Across tabs, the POST runs under the Web Lock
// "potem-refresh", so a second tab waits for the first and then sends a POST
// the BFF answers as a no-op (the session is no longer due). Two tabs
// rotating from the same refresh token at once could leave the browser
// holding a superseded one (the BFF's comment explains how).
//
// Signing out happens once per page: the mirror is cleared, the other tabs are
// told on BroadcastChannel("potem-session"), and the listeners run. A tab that
// hears it from another does the same without posting again. A page that
// signed out stays signed out: signing in again is a navigation to
// /auth/login, which loads a fresh page.

import type { MirrorStore } from "../sync/store.ts";
import { throttle } from "./throttle.ts";

export type SessionInfo = { signed_in: false } | { signed_in: true; expires_at: number; data_key: string };

/** The part of navigator.locks the refresh uses. */
export interface LockRequester {
  request<T>(name: string, cb: () => Promise<T>): Promise<T>;
}

export interface SessionClient {
  /** GET /bff/session. Signed out runs the signed-out flow; a server error throws. */
  current(): Promise<SessionInfo>;
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
  let signedOut = false;

  function endSession(broadcast: boolean): void {
    if (signedOut) return;
    signedOut = true;
    store.clear();
    if (broadcast) channel?.postMessage(SIGNED_OUT_MESSAGE);
    for (const cb of [...listeners]) cb();
  }

  channel?.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as { type?: unknown } | null;
    if (typeof data === "object" && data !== null && data.type === SIGNED_OUT_MESSAGE.type) endSession(false);
  });

  async function post(force: boolean): Promise<boolean> {
    const headers: Record<string, string> = force ? { ...CSRF_HEADER, "x-potem-force": "1" } : CSRF_HEADER;
    const res = await fetchFn("/bff/session/refresh", { method: "POST", headers });
    if (res.status === 204) return true;
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (res.status === 401 && body?.error === "signed_out") {
      endSession(true);
      return false;
    }
    throw new Error(`session refresh failed: ${res.status}${typeof body?.error === "string" ? ` ${body.error}` : ""}`);
  }

  return {
    async current() {
      const res = await fetchFn("/bff/session");
      if (!res.ok) throw new Error(`session check failed: ${res.status}`);
      const info = (await res.json()) as SessionInfo;
      if (info.signed_in !== true) {
        endSession(true);
        return { signed_in: false };
      }
      return info;
    },

    refreshOnce({ force = false } = {}) {
      if (signedOut) return Promise.resolve(false);
      let p = inflight.get(force);
      if (!p) {
        p = (locks ? locks.request("potem-refresh", () => post(force)) : post(force)).finally(() => inflight.delete(force));
        inflight.set(force, p);
      }
      return p;
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

/**
 * Keeps the BFF's idle timer alive while the person uses the page: GET
 * /bff/session is the only request that moves it. Pointer and keyboard input
 * and the page becoming visible count, at most once a minute; the page's own
 * check on load counts as the first. Returns a function that stops watching.
 */
export function watchActivity(
  session: Pick<SessionClient, "current">,
  env: { target: EventTarget; doc: EventTarget & { visibilityState: DocumentVisibilityState } },
): () => void {
  const check = throttle(() => {
    session.current().catch((e: unknown) => console.warn("session check failed", e));
  }, ACTIVITY_INTERVAL_MS);
  const onVisible = () => {
    if (env.doc.visibilityState === "visible") check();
  };
  env.target.addEventListener("pointerdown", check);
  env.target.addEventListener("keydown", check);
  env.doc.addEventListener("visibilitychange", onVisible);
  return () => {
    env.target.removeEventListener("pointerdown", check);
    env.target.removeEventListener("keydown", check);
    env.doc.removeEventListener("visibilitychange", onVisible);
  };
}
