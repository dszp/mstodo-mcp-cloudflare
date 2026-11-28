// Reads from the BFF that the mirror doesn't hold: "search all history" and a
// task outside the synced scope. Each request can be abandoned: a new search
// aborts the one before it, and an abandoned request answers null, so a slow
// stale response can never replace a newer one.

import { type BffFetch, SignedOutError } from "./api.ts";

export type Remote<T> = { ok: true; data: T } | { ok: false; status: number | null };

/** Hands out one AbortSignal at a time; starting the next aborts the previous. */
export function createLatest(): { next(): AbortSignal; cancel(): void } {
  let current: AbortController | null = null;
  return {
    next() {
      current?.abort();
      current = new AbortController();
      return current.signal;
    },
    cancel() {
      current?.abort();
      current = null;
    },
  };
}

/**
 * GET `path` from the BFF and parse the JSON body. `status` is the HTTP status
 * of a failure, null when there was none (network, or a signed-out page). Null
 * when `signal` aborted, or the session ended (the signed-out view shows then).
 */
export async function loadRemote<T>(
  bff: BffFetch,
  path: string,
  parse: (json: unknown) => T | null,
  signal: AbortSignal,
): Promise<Remote<T> | null> {
  try {
    const res = await bff(path, { signal });
    if (!res.ok) return signal.aborted ? null : { ok: false, status: res.status };
    const body: unknown = await res.json().catch(() => null);
    if (signal.aborted) return null;
    const data = parse(body);
    return data === null ? { ok: false, status: res.status } : { ok: true, data };
  } catch (e) {
    if (signal.aborted || e instanceof SignedOutError) return null;
    return { ok: false, status: null };
  }
}
