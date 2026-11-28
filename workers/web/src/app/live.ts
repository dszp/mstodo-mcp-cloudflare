// Live updates: the server's push socket (through the BFF relay, sync/push.ts)
// says when to pull, and the 30-second poll (watchVisiblePoll) covers the
// times it can't: while connecting, after a drop, on the Vite dev server
// (which has no socket), or when the relay or the server is down.

import { type Cancel, type PushState, type SocketLike, createPush } from "../sync/push.ts";
import { SignedOutError } from "./api.ts";
import { type Loader, watchVisiblePoll } from "./loader.ts";
import type { SessionClient } from "./session.ts";

/** A page hidden this long closes its socket; showing it again reconnects. */
const HIDDEN_CLOSE_MS = 5 * 60_000;

export interface LiveDeps {
  loader: Pick<Loader, "reload" | "pullAfter">;
  session: Pick<SessionClient, "ensureFresh" | "onSignedOut" | "signedOut">;
  doc: EventTarget & { visibilityState: string };
  /** A new socket to /bff/socket. */
  openSocket(): SocketLike;
  schedule(fn: () => void, ms: number): Cancel;
  /** In [0, 1), for the reconnect jitter. */
  random(): number;
  log(event: string): void;
}

/**
 * Keeps the mirror current while the page is ready:
 *
 * - A hello or changed notice pulls (loader.pullAfter, so the pull starts
 *   after one in flight and sees the change). Notices that arrive while that
 *   pull is pending collapse into one more pull when it settles, so the last
 *   change is never dropped and a burst costs two pulls, not one per notice.
 * - The poll runs only while the socket isn't open. It is started and stopped
 *   rather than paused: a fresh start waits 30 s, and the socket's notices
 *   covered the time before the drop.
 * - A 4001 close means the relay or server wants the session checked:
 *   ensureFresh reads /bff/session and refreshes when the access token is due.
 *   A session that is gone has already run the sign-out flow by then. This
 *   refresh is automatic, so it can't keep an unattended session alive: only
 *   a session read that reports activity moves the BFF's idle timer
 *   (bff/api.ts).
 * - Hidden for 5 minutes closes the socket; visible again reconnects, and the
 *   hello pulls.
 * - Sign-out, here or in another tab, stops everything.
 *
 * Returns a function that stops it.
 */
export function watchLive(deps: LiveDeps): () => void {
  const { loader, session, doc } = deps;
  let stopped = false;
  let stopPoll: (() => void) | null = null;
  let hiddenTimer: Cancel | null = null;
  let pushRunning = false;
  let pulling = false;
  let dirty = false;

  const pull = () => {
    if (stopped) return;
    if (pulling) {
      dirty = true;
      return;
    }
    pulling = true;
    loader
      .pullAfter()
      .catch((e: unknown) => {
        if (e instanceof SignedOutError) return; // sign-out stops everything anyway
        console.warn("pull on push notice failed", e);
      })
      .finally(() => {
        pulling = false;
        if (dirty) {
          dirty = false;
          pull();
        }
      });
  };

  const onState = (s: PushState) => {
    if (stopped) return;
    if (s === "open") {
      stopPoll?.();
      stopPoll = null;
    } else {
      stopPoll ??= watchVisiblePoll(loader, doc);
    }
  };

  const push = createPush({
    open: deps.openSocket,
    schedule: deps.schedule,
    random: deps.random,
    onHello: pull,
    onChanged: pull,
    onSessionCheck: async () => {
      if (await session.ensureFresh()) return "ok";
      stop();
      return "signed_out";
    },
    onState,
    log: deps.log,
  });

  const startPush = () => {
    pushRunning = true;
    push.start();
  };

  const onVisibility = () => {
    if (stopped) return;
    if (doc.visibilityState === "visible") {
      hiddenTimer?.();
      hiddenTimer = null;
      if (!pushRunning) startPush();
    } else if (pushRunning && hiddenTimer === null) {
      hiddenTimer = deps.schedule(() => {
        hiddenTimer = null;
        pushRunning = false;
        push.stop();
      }, HIDDEN_CLOSE_MS);
    }
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    stopSignedOut();
    doc.removeEventListener("visibilitychange", onVisibility);
    hiddenTimer?.();
    hiddenTimer = null;
    push.stop();
    stopPoll?.();
    stopPoll = null;
  }

  const stopSignedOut = session.onSignedOut(stop);
  if (session.signedOut) {
    stop();
    return stop;
  }
  doc.addEventListener("visibilitychange", onVisibility);
  startPush();
  onVisibility(); // a page that loads hidden starts its 5 minutes now
  return stop;
}
