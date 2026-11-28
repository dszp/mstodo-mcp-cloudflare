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
  pending(): readonly Mutation[];
  subscribe(fn: () => void): () => void;
  flush(): Promise<void>;
  discard(): number;
  onRejected(fn: (m: Mutation, rejection: Rejection) => void): () => void;
}

const BATCH_WINDOW_MS = 300;
const MAX_BATCH = 25; // SYNC-API §5.1
// The BFF refuses a body over 256 KiB. Capping the mutations at 192 KiB leaves
// room for the envelope the app's send adds ({client_id, mutations}).
const MAX_BATCH_BYTES = 192 * 1024;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

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
// - enqueue starts a 300 ms window (if no timer is set); every edit made in it
//   goes in the same batch. While a request is open, new edits wait for the
//   next batch of the same run; one that lands as the run ends gets a new window.
// - A batch holds at most 25 mutations and 192 KiB of JSON. A single mutation
//   larger than that can never be sent: it leaves the queue through onRejected
//   with error "too_large".
// - A run sends batches until the queue is empty, then ends. A thrown send, a
//   `failed` with retry: true, or an answer that removed nothing ends the run
//   and schedules the next one after a backoff of 1 s, 2 s, 4 s … capped at
//   30 s. An answer that removed something with no `failed` among it resets the
//   backoff and the run goes on: `skipped` from the server's time budget is
//   normal. Ids never change, so a retry the server already applied comes back
//   `duplicate`.
// - A permanent error (isPermanent: the request itself is refused, e.g. 400 or
//   413) is never retried as is. The batch is split in half and the halves go
//   in order, down to the one mutation the server refuses, which leaves through
//   onRejected with error "refused". The good edits around it still go through.
// - After each answered batch the outbox awaits pull() before removing the
//   batch's mutations, so an overlay built from pending() never drops an edit
//   before the mirror has the server's state. A thrown send doesn't pull: the
//   edits stay pending and the retry's answer pulls.
// - A signed-out error stops the outbox for good. The edits stay in pending()
//   until discard(), so sign-out can say how many were not sent.
// - onRejected fires only for mutations still queued; a discard during a
//   request silences the answer for what it dropped.
// - flush() sends now, skipping any window or backoff timer. Called during a
//   run, it starts no second request and resolves when that run ends: the
//   queue is empty, the run backed off, or the session signed out.
export function createOutbox(deps: OutboxDeps): Outbox {
  let queue: readonly Mutation[] = [];
  let timer: Cancel | null = null;
  let run: Promise<void> | null = null;
  let failures = 0;
  let stopped = false;
  const watchers = new Set<() => void>();
  const rejectWatchers = new Set<(m: Mutation, r: Rejection) => void>();

  // A listener that throws must not break the send loop or the other listeners.
  const notify = () => {
    for (const fn of [...watchers]) {
      try {
        fn();
      } catch {
        /* listener's own error */
      }
    }
  };
  const reject = (m: Mutation, r: Rejection) => {
    for (const fn of [...rejectWatchers]) {
      try {
        fn(m, r);
      } catch {
        /* listener's own error */
      }
    }
  };

  const clearTimer = () => {
    timer?.();
    timer = null;
  };

  const later = (ms: number) => {
    clearTimer();
    timer = deps.schedule(() => {
      timer = null;
      void flush();
    }, ms);
  };

  // Nothing left to retry (a discard during the request) means no timer.
  const backOff = () => {
    if (queue.length === 0) return;
    failures += 1;
    later(Math.min(BACKOFF_START_MS * 2 ** (failures - 1), BACKOFF_CAP_MS));
  };

  // Removes mutations that are still queued and reports the rejected ones.
  const drop = (ids: Set<string>, rejected: [Mutation, Rejection][]) => {
    const queued = new Set(queue.map((m) => m.id));
    queue = queue.filter((m) => !ids.has(m.id));
    if (queue.length !== queued.size) notify();
    for (const [m, r] of rejected) if (queued.has(m.id)) reject(m, r);
  };

  const dropOne = (m: Mutation, error: string) => drop(new Set([m.id]), [[m, { error }]]);

  // Applies one answer. `removed` counts the sent mutations the answer takes
  // out of the queue; `failed` is true when any came back failed with retry.
  const settle = (batch: Mutation[], res: SendResult): { removed: number; failed: boolean } => {
    const byId = new Map<string, MutationResult>();
    for (const r of Array.isArray(res?.results) ? res.results : []) {
      if (r && typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, r);
    }
    const remove = new Set<string>();
    const rejected: [Mutation, Rejection][] = [];
    let failed = false;
    for (const m of batch) {
      const r = byId.get(m.id);
      if (!r) continue; // missing from results: retry it
      if (r.status === "applied" || r.status === "duplicate") remove.add(m.id);
      else if (r.status === "rejected") {
        remove.add(m.id);
        rejected.push([m, { error: r.error }]);
      } else if (r.status === "failed" && r.retry === false) {
        remove.add(m.id);
        rejected.push([m, { error: r.error, retry: false }]);
      } else if (r.status === "failed") failed = true;
      // skipped, or an unknown status: kept
    }
    drop(remove, rejected);
    return { removed: remove.size, failed };
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
        let res: SendResult;
        try {
          res = await deps.send(part);
        } catch (err) {
          if (deps.isSignedOut(err)) {
            stopped = true;
            clearTimer();
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
        try {
          await deps.pull();
        } catch {
          // The next pull catches up; the answer itself is still good.
        }
        const { removed, failed } = settle(part, res);
        if (failed || removed === 0) {
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
    if (stopped || queue.length === 0) return Promise.resolve();
    clearTimer();
    run = loop().finally(() => {
      run = null;
      // An edit enqueued after the loop returned but before this ran saw a run
      // in progress and set no timer.
      if (!stopped && queue.length > 0 && !timer) later(BATCH_WINDOW_MS);
    });
    return run;
  };

  return {
    enqueue(input) {
      const m: Mutation = { ...input, id: deps.random(), at: deps.now().toISOString() };
      queue = [...queue, m];
      notify();
      if (!stopped && !run && !timer) later(BATCH_WINDOW_MS);
      return m;
    },
    pending: () => queue,
    subscribe(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    flush,
    discard() {
      const n = queue.length;
      clearTimer();
      failures = 0;
      queue = [];
      if (n > 0) notify();
      return n;
    },
    onRejected(fn) {
      rejectWatchers.add(fn);
      return () => rejectWatchers.delete(fn);
    },
  };
}
