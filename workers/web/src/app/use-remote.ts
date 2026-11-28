import { useCallback, useEffect, useRef, useState } from "react";
import type { BffFetch } from "./api.ts";
import { createLatest, loadRemote } from "./remote.ts";

export type RemoteState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; httpStatus: number | null }
  | { status: "ok"; data: T };

/**
 * GET `path` from the BFF (null: nothing to load) and parse it. A new path, or
 * retry(), abandons the request in flight, and unmounting abandons it too. The
 * state is for the current path only: after a path change it reads "loading",
 * never the previous path's answer.
 */
export function useRemote<T>(
  bff: BffFetch,
  path: string | null,
  parse: (json: unknown) => T | null,
): [RemoteState<T>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [done, setDone] = useState<{ path: string; attempt: number; state: RemoteState<T> } | null>(null);
  const latest = useRef(createLatest());

  useEffect(() => {
    if (path === null) return;
    const signal = latest.current.next();
    void loadRemote(bff, path, parse, signal).then((r) => {
      if (r === null) return; // abandoned, or the session ended
      setDone({ path, attempt, state: r.ok ? { status: "ok", data: r.data } : { status: "error", httpStatus: r.status } });
    });
    return () => latest.current.cancel();
  }, [bff, path, attempt, parse]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (path === null) return [{ status: "idle" }, retry];
  if (done === null || done.path !== path || done.attempt !== attempt) return [{ status: "loading" }, retry];
  return [done.state, retry];
}
