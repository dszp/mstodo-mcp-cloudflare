type VisibleDoc = EventTarget & { visibilityState: DocumentVisibilityState | string };

/**
 * Calls `fn` once `ms` have passed with the page visible. Hiding the page
 * stops the clock; showing it again starts the full delay over, so a notice
 * raised while the tab was in the background is still there to read when the
 * user comes back. Returns a cancel.
 */
export function visibleTimeout(doc: VisibleDoc, ms: number, fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const sync = () => {
    if (doc.visibilityState === "visible") {
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          cancel();
          fn();
        }, ms);
      }
    } else stopTimer();
  };
  const cancel = () => {
    stopTimer();
    doc.removeEventListener("visibilitychange", sync);
  };
  doc.addEventListener("visibilitychange", sync);
  sync();
  return cancel;
}
