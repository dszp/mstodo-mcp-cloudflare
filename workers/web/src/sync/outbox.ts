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
}

export interface Rejection {
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
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

// Queues edits and sends them in order, at most 25 per request and one request
// at a time.
//
// - enqueue starts a 300 ms window (if no timer is set); every edit made in it
//   goes in the same batch. While a request is open, new edits wait for the
//   next batch of the same run.
// - A run sends batches until the queue is empty, then ends. A batch that
//   leaves any of its own mutations in the queue (a thrown send, `failed` with
//   retry: true, `skipped`, or a result that is missing) ends the run and
//   schedules the next one after a backoff of 1 s, 2 s, 4 s … capped at 30 s.
//   A batch whose every mutation left the queue resets the backoff. Ids never
//   change, so a retry the server already applied comes back `duplicate`.
// - After each answered batch the outbox awaits pull() before removing the
//   batch's mutations, so an overlay built from pending() never drops an edit
//   before the mirror has the server's state. A thrown send doesn't pull: the
//   edits stay pending and the retry's answer pulls.
// - A signed-out error stops the outbox for good. The edits stay in pending()
//   until discard(), so sign-out can say how many were not sent.
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

  const backOff = () => {
    failures += 1;
    later(Math.min(BACKOFF_START_MS * 2 ** (failures - 1), BACKOFF_CAP_MS));
  };

  // Applies one answer. Returns true when every sent mutation left the queue.
  const settle = (batch: Mutation[], res: SendResult): boolean => {
    const byId = new Map<string, MutationResult>();
    for (const r of Array.isArray(res?.results) ? res.results : []) {
      if (r && typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, r);
    }
    const remove = new Set<string>();
    const rejected: [Mutation, Rejection][] = [];
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
      }
      // failed with retry: true, skipped, or an unknown status: kept
    }
    // A discard during the request may already have removed some of these.
    const before = queue.length;
    queue = queue.filter((m) => !remove.has(m.id));
    if (queue.length !== before) notify();
    for (const [m, r] of rejected) reject(m, r);
    return remove.size === batch.length;
  };

  const loop = async () => {
    while (!stopped && queue.length > 0) {
      const batch = queue.slice(0, MAX_BATCH);
      let res: SendResult;
      try {
        res = await deps.send(batch);
      } catch (err) {
        if (deps.isSignedOut(err)) {
          stopped = true;
          clearTimer();
        } else backOff();
        return;
      }
      try {
        await deps.pull();
      } catch {
        // The next pull catches up; the answer itself is still good.
      }
      if (!settle(batch, res)) {
        backOff();
        return;
      }
      failures = 0;
    }
  };

  const flush = (): Promise<void> => {
    if (run) return run;
    if (stopped || queue.length === 0) return Promise.resolve();
    clearTimer();
    run = loop().finally(() => {
      run = null;
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
