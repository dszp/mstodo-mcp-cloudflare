// Fewer `changed` messages per edit (docs/SYNC-API.md section 7.1). One edit
// moves the change log several times: twice inside the request that made it,
// then again a second or two later when the server learns values it didn't
// write (Graph's echo, Substrate's order). Each move used to be its own
// message, and each message is a pull.
//
// The first change after a quiet spell is sent at once, so a lone edit isn't
// delayed. Changes inside the window after a send are held and sent as one
// message, with the newest cursor, when the window ends.
import type { ChangeNotifier } from "../ports";

export const COALESCE_WINDOW_MS = 3_000;

export interface Timers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function coalescing(inner: ChangeNotifier, windowMs = COALESCE_WINDOW_MS, timers: Timers = realTimers): ChangeNotifier {
  let lastSentAt = -Infinity;
  let held: string | null = null;
  let timer: unknown = null;

  const flush = () => {
    timer = null;
    if (held === null) return;
    const cursor = held;
    held = null;
    lastSentAt = timers.now();
    inner.announce(cursor);
  };

  return {
    announce(cursor) {
      const wait = lastSentAt + windowMs - timers.now();
      if (wait <= 0 && timer === null) {
        lastSentAt = timers.now();
        inner.announce(cursor);
        return;
      }
      held = cursor;
      if (timer === null) timer = timers.setTimeout(flush, Math.max(wait, 0));
    },
    // Closing ends the sockets the held message was for.
    closeAll(reason) {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      held = null;
      inner.closeAll(reason);
    },
    sweep() {
      inner.sweep();
    },
  };
}
