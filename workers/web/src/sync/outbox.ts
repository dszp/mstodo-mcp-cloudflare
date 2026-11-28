import type { Mutation, MutationResult, SendResult } from "./mutation";

export type Cancel = () => void;

export interface OutboxDeps {
  // Posts one batch. Resolves with the §5.3 body; throws when no body came back.
  send(batch: Mutation[]): Promise<SendResult>;
  // Brings the mirror up to date with the server.
  pull(): Promise<void>;
  now(): Date;
  // A fresh mutation id (the app passes crypto.randomUUID).
  random(): string;
  schedule(fn: () => void, ms: number): Cancel;
  // True for the error send throws once the session has signed out. Injected so
  // the engine never imports the app's error class.
  isSignedOut(err: unknown): boolean;
  // True for an error that says the request itself will never be accepted
  // (the app maps HTTP 400, 413 and 415 here), so resending it as is can't help.
  isPermanent(err: unknown): boolean;
}

export interface Rejection {
  // The server's §5.3 error, or the outbox's own: "too_large" (one mutation is
  // bigger than a request may be) or "refused" (the request holding only this
  // mutation got a permanent error).
  error: string;
  // Present when the server answered `failed` with retry: false.
  retry?: false;
}

export interface Outbox {
  enqueue(m: Omit<Mutation, "id" | "at">): Mutation;
  /**
   * What the overlay shows: edits the server applied whose pull hasn't
   * landed yet, then the unsent ones, in order.
   */
  pending(): readonly Mutation[];
  /** Edits the server hasn't answered yet: what closing the tab or signing out would lose. */
  unsent(): readonly Mutation[];
  subscribe(fn: () => void): () => void;
  flush(): Promise<void>;
  /** Drops everything; returns how many edits were unsent. */
  discard(): number;
  onRejected(fn: (m: Mutation, rejection: Rejection) => void): () => void;
  /** An applied edit some of whose fields the server skipped, because a newer edit had set them (§6). */
  onSuperseded(fn: (m: Mutation, fields: string[]) => void): () => void;
}

const BATCH_WINDOW_MS = 300;
const MAX_BATCH = 25; // SYNC-API §5.1
// The BFF refuses a body over 256 KiB. Capping the mutations at 192 KiB leaves
// room for the envelope the app's send adds ({client_id, mutations}).
const MAX_BATCH_BYTES = 192 * 1024;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
// A mutation the server keeps answering `failed` with retry: true is given up
// after this many answers, or once this long has passed since the first one.
const MAX_FAILED_ANSWERS = 5;
const MAX_FAILING_MS = 5 * 60_000;
const PULL_RETRY_START_MS = 2000;

// UTF-8 length of a string. The engine's ES2022 lib has no TextEncoder.
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

// Queues edits and sends them in order, one request at a time.
//
// - enqueue starts a 300 ms window (if no window is set); every edit made in
//   it goes in the same batch. While a request is open, new edits wait for the
//   next batch of the same run; one that lands as the run ends gets a new
//   window. An edit made during a backoff replaces the backoff with a window:
//   the head goes again with it, which is safe because ids never change.
// - A batch holds at most 25 mutations and 192 KiB of JSON. A single mutation
//   larger than that can never be sent: it leaves the queue through onRejected
//   with error "too_large".
// - A run sends batches until the queue is empty, then ends. A thrown send, a
//   `failed` with retry: true, or an answer that removed nothing ends the run
//   and schedules the next one after a backoff of 1 s, 2 s, 4 s … capped at
//   30 s. An answer that removed something with no `failed` among it resets the
//   backoff and the run goes on: `skipped` from the server's time budget is
//   normal. Ids never change, so a retry the server already applied comes back
//   `duplicate`, carrying the stored result, which is read as if it were new.
// - A mutation answered `failed` with retry: true a sixth time, or more than
//   5 minutes after its first such answer, leaves through onRejected with the
//   last error: a server that keeps failing it would otherwise back off every
//   later edit too.
// - A permanent error (isPermanent: the request itself is refused, e.g. 400 or
//   413) is never retried as is. The batch is split in half and the halves go
//   in order, down to the one mutation the server refuses, which leaves through
//   onRejected with error "refused". The good edits around it still go through.
// - After each answered batch the outbox calls pull(), which must start a pull
//   after the call (loader.pullAfter): one already running may predate the
//   server's write. An applied edit leaves unsent() at once but stays in
//   pending(), so the overlay keeps showing it until a pull that began after
//   its answer succeeds. A failed pull is retried after 2 s, 4 s … capped at
//   30 s; flush() retries it at once. A rejected edit leaves pending() after
//   the pull whether or not it succeeded: the server didn't make that change.
//   A thrown send doesn't pull: the edits stay unsent and the retry's answer
//   pulls.
// - A signed-out error (from send or pull) stops the outbox for good. The
//   unsent edits stay until discard(), so sign-out can say how many were lost.
// - onRejected and onSuperseded fire only for mutations not discarded; a
//   discard during a request silences the answer for what it dropped.
// - flush() sends now, skipping any window or backoff timer. Called during a
//   run, it starts no second request and resolves when that run ends: the
//   queue is empty, the run backed off, or the session signed out.
export function createOutbox(deps: OutboxDeps): Outbox {
  let queue: readonly Mutation[] = [];
  // Applied, awaiting a pull that began after the answer.
  let landed: readonly Mutation[] = [];
  let shown: readonly Mutation[] = [];
  let timer: Cancel | null = null;
  let timerIsBackoff = false;
  let run: Promise<void> | null = null;
  let failures = 0;
  let pullTimer: Cancel | null = null;
  let pullFailures = 0;
  let retrying: Promise<void> | null = null;
  let stopped = false;
  // Bumped by discard, so an answer to a request sent before it reports nothing.
  let epoch = 0;
  // `failed` answers with retry: true, per mutation id.
  const failedAnswers = new Map<string, { count: number; first: number }>();
  const watchers = new Set<() => void>();
  const rejectWatchers = new Set<(m: Mutation, r: Rejection) => void>();
  const supersededWatchers = new Set<(m: Mutation, fields: string[]) => void>();

  // A listener that throws must not break the send loop or the other listeners.
  const each = <A extends unknown[]>(fns: Set<(...a: A) => void>, ...args: A) => {
    for (const fn of [...fns]) {
      try {
        fn(...args);
      } catch {
        /* listener's own error */
      }
    }
  };
  const changed = () => {
    shown = landed.length === 0 ? queue : [...landed, ...queue];
    each(watchers);
  };

  const clearTimer = () => {
    timer?.();
    timer = null;
  };
  const clearPullTimer = () => {
    pullTimer?.();
    pullTimer = null;
  };

  const later = (ms: number, backoff: boolean) => {
    clearTimer();
    timerIsBackoff = backoff;
    timer = deps.schedule(() => {
      timer = null;
      void flush();
    }, ms);
  };

  const stop = () => {
    stopped = true;
    clearTimer();
    clearPullTimer();
  };

  // Nothing left to retry (a discard during the request) means no timer.
  const backOff = () => {
    if (queue.length === 0) return;
    failures += 1;
    later(Math.min(BACKOFF_START_MS * 2 ** (failures - 1), BACKOFF_CAP_MS), true);
  };

  // Removes mutations that are still queued and reports the rejected ones.
  const drop = (ids: Set<string>, rejected: [Mutation, Rejection][]) => {
    const queued = new Set(queue.map((m) => m.id));
    queue = queue.filter((m) => !ids.has(m.id));
    for (const id of ids) failedAnswers.delete(id);
    if (queue.length !== queued.size) changed();
    for (const [m, r] of rejected) if (queued.has(m.id)) each(rejectWatchers, m, r);
  };

  const dropOne = (m: Mutation, error: string) => drop(new Set([m.id]), [[m, { error }]]);

  // Pulls, then takes out of pending() the applied edits that were waiting
  // when the pull was asked for. A failure schedules a retry while any wait.
  const pullLanded = async (): Promise<void> => {
    const waiting = new Set(landed.map((m) => m.id));
    try {
      await deps.pull();
    } catch (err) {
      if (deps.isSignedOut(err)) {
        stop();
        return;
      }
      if (landed.length > 0 && !stopped && !pullTimer) {
        pullFailures += 1;
        pullTimer = deps.schedule(
          () => {
            pullTimer = null;
            void retryPull();
          },
          Math.min(PULL_RETRY_START_MS * 2 ** (pullFailures - 1), BACKOFF_CAP_MS),
        );
      }
      return;
    }
    pullFailures = 0;
    if (waiting.size > 0) {
      const before = landed.length;
      landed = landed.filter((m) => !waiting.has(m.id));
      if (landed.length !== before) changed();
    }
    if (landed.length === 0) clearPullTimer();
  };

  const retryPull = (): Promise<void> => {
    retrying ??= pullLanded().finally(() => {
      retrying = null;
    });
    return retrying;
  };

  interface Outcome {
    applied: Mutation[];
    superseded: [Mutation, string[]][];
    remove: Set<string>;
    rejected: [Mutation, Rejection][];
    // Some mutation came back failed with retry and is kept.
    failed: boolean;
  }

  // Reads one answer for the mutations of `batch` that are still queued.
  const settle = (batch: Mutation[], res: SendResult): Outcome => {
    const byId = new Map<string, MutationResult>();
    for (const r of Array.isArray(res?.results) ? res.results : []) {
      if (r && typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, r);
    }
    const queued = new Set(queue.map((m) => m.id));
    const out: Outcome = { applied: [], superseded: [], remove: new Set(), rejected: [], failed: false };
    for (const m of batch) {
      if (!queued.has(m.id)) continue;
      let r = byId.get(m.id);
      if (!r) continue; // missing from results: retry it
      // A repeat answers with what the first answer was.
      if (r.status === "duplicate") {
        const stored = r.result;
        r =
          stored && (stored.status === "applied" || (stored.status === "rejected" && typeof stored.error === "string"))
            ? stored
            : { id: m.id, status: "applied" };
      }
      if (r.status === "applied") {
        out.applied.push(m);
        const fields = Array.isArray(r.superseded_fields) ? r.superseded_fields.filter((f) => typeof f === "string") : [];
        if (fields.length > 0) out.superseded.push([m, fields]);
      } else if (r.status === "rejected") {
        out.remove.add(m.id);
        out.rejected.push([m, { error: r.error }]);
      } else if (r.status === "failed" && r.retry === false) {
        out.remove.add(m.id);
        out.rejected.push([m, { error: r.error, retry: false }]);
      } else if (r.status === "failed") {
        const now = deps.now().getTime();
        const f = failedAnswers.get(m.id) ?? { count: 0, first: now };
        f.count += 1;
        failedAnswers.set(m.id, f);
        if (f.count > MAX_FAILED_ANSWERS || now - f.first > MAX_FAILING_MS) {
          out.remove.add(m.id);
          out.rejected.push([m, { error: r.error }]);
        } else out.failed = true;
      }
      // skipped, or an unknown status: kept
    }
    return out;
  };

  // The longest run from the queue head that fits in one request.
  const nextBatch = (): Mutation[] => {
    const batch: Mutation[] = [];
    let bytes = 2; // [ ]
    for (const m of queue) {
      if (batch.length === MAX_BATCH) break;
      const size = utf8Bytes(JSON.stringify(m)) + (batch.length > 0 ? 1 : 0);
      if (bytes + size > MAX_BATCH_BYTES) break;
      batch.push(m);
      bytes += size;
    }
    return batch;
  };

  const loop = async () => {
    while (!stopped && queue.length > 0) {
      const batch = nextBatch();
      if (batch.length === 0) {
        dropOne(queue[0]!, "too_large");
        continue;
      }
      // Halves of a permanently refused batch, sent front to back.
      const parts: Mutation[][] = [batch];
      while (parts.length > 0) {
        const part = parts.shift()!.filter((m) => queue.includes(m));
        if (part.length === 0) continue;
        const sentEpoch = epoch;
        let res: SendResult;
        try {
          res = await deps.send(part);
        } catch (err) {
          if (deps.isSignedOut(err)) {
            stop();
            return;
          }
          if (deps.isPermanent(err)) {
            if (part.length === 1) dropOne(part[0]!, "refused");
            else {
              const mid = Math.ceil(part.length / 2);
              parts.unshift(part.slice(0, mid), part.slice(mid));
            }
            continue;
          }
          backOff();
          return;
        }
        const out = settle(part, res);
        // Applied edits leave the unsent queue now and the overlay after the pull.
        if (out.applied.length > 0) {
          const ids = new Set(out.applied.map((m) => m.id));
          for (const id of ids) failedAnswers.delete(id);
          queue = queue.filter((m) => !ids.has(m.id));
          landed = [...landed, ...out.applied];
          changed();
        }
        await pullLanded();
        drop(out.remove, out.rejected);
        if (epoch === sentEpoch) for (const [m, fields] of out.superseded) each(supersededWatchers, m, fields);
        if (stopped) return;
        const removed = out.applied.length + out.remove.size;
        if (out.failed || removed === 0) {
          backOff();
          return;
        }
        failures = 0;
        // Something of this part is still queued and must go before the parts
        // after it, so take the next batch from the queue head again.
        if (removed < part.length) break;
      }
    }
  };

  const flush = (): Promise<void> => {
    if (run) return run;
    if (stopped) return Promise.resolve();
    if (queue.length === 0) {
      if (landed.length === 0) return Promise.resolve();
      clearPullTimer();
      return retryPull();
    }
    clearTimer();
    run = loop().finally(() => {
      run = null;
      // An edit enqueued after the loop returned but before this ran saw a run
      // in progress and set no timer.
      if (!stopped && queue.length > 0 && !timer) later(BATCH_WINDOW_MS, false);
    });
    return run;
  };

  return {
    enqueue(input) {
      const m: Mutation = { ...input, id: deps.random(), at: deps.now().toISOString() };
      queue = [...queue, m];
      changed();
      if (!stopped && !run && (!timer || timerIsBackoff)) later(BATCH_WINDOW_MS, false);
      return m;
    },
    pending: () => shown,
    unsent: () => queue,
    subscribe(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    flush,
    discard() {
      const n = queue.length;
      const had = n + landed.length;
      clearTimer();
      clearPullTimer();
      failures = 0;
      pullFailures = 0;
      failedAnswers.clear();
      epoch += 1;
      queue = [];
      landed = [];
      if (had > 0) changed();
      return n;
    },
    onRejected(fn) {
      rejectWatchers.add(fn);
      return () => rejectWatchers.delete(fn);
    },
    onSuperseded(fn) {
      supersededWatchers.add(fn);
      return () => supersededWatchers.delete(fn);
    },
  };
}
