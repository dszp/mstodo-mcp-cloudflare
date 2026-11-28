/**
 * Calls `fn` at most once per `intervalMs`, on the leading edge; calls inside
 * the interval are dropped. The clock starts at creation, as if `fn` had just
 * run: each caller makes the same call itself on load.
 */
export function throttle(fn: () => void, intervalMs: number): () => void {
  let last = Date.now();
  return () => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    fn();
  };
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Runs a waiting call now. */
  flush(): void;
  /** Drops a waiting call. */
  cancel(): void;
  /** Whether a call is waiting. */
  pending(): boolean;
}

/** Calls `fn` with the last arguments once `waitMs` pass with no further call. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let args: A | null = null;
  const run = () => {
    timer = null;
    const a = args;
    args = null;
    if (a !== null) fn(...a);
  };
  const debounced = ((...a: A) => {
    args = a;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, waitMs);
  }) as Debounced<A>;
  debounced.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    run();
  };
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    args = null;
  };
  debounced.pending = () => timer !== null;
  return debounced;
}
