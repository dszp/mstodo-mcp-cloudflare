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
