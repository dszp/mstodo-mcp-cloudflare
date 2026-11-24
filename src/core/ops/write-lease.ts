import { log } from "../log";
import type { IndexBackend } from "../ports";

// The single write queue (docs/SYNC-API.md section 18.4), client side.
//
// Every op in src/core/ops runs inside WriteLease.run(), so an MCP tool, a sync
// mutation and (later) an n8n route never interleave their Graph/Substrate
// calls. Each Graph call yields, so without this a retried sync batch, a second
// device and an MCP tool could all be mid-write on the same task at once.
//
// Topology: the ops run where the request is — the per-session McpAgent on
// Cloudflare, the request handler on Node — and only the index (the TodoIndex
// Durable Object, or IndexCore in process) is shared. A closure can't cross DO
// RPC, so the queue is a lease held by the index (IndexCore.acquireWriteLease)
// and this class is the waiting side:
//
//   - acquire: poll with capped backoff until granted or `waitMs` runs out,
//     then throw WriteBusyError (surfaced as `write_busy`, retryable). Waiters
//     are not FIFO; for one owner's handful of clients that is acceptable.
//   - renew: while the work runs, re-acquire every ttl/3 so a long write (a
//     move copying attachments, a throttled Substrate call) keeps the lease. A
//     holder that dies stops renewing and the TTL frees the lease.
//   - release: in `finally`. A failed release is logged; the TTL covers it.
//   - reentrant: one WriteLease is one writer. A nested run() on the same
//     instance (a sync batch holding the lease around an op that also takes
//     it) runs inline instead of deadlocking on itself.
//
// If the index can't be reached to acquire, the write proceeds unserialized
// and logs `write_lease_unavailable`: that is the behavior before the queue
// existed, and refusing every write while the index is unreachable would turn
// a consistency feature into an outage. A *busy* lease never proceeds.

export type WriteLeasePort = Pick<IndexBackend, "acquireWriteLease" | "releaseWriteLease">;

export class WriteBusyError extends Error {
  readonly reason = "write_busy";
  constructor(readonly waitedMs: number) {
    super("write_busy");
  }
}

export interface WriteLeaseOptions {
  holder?: string;
  ttlMs?: number;
  waitMs?: number;
  // Injected by tests.
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const WRITE_LEASE_TTL_MS = 30_000;
export const WRITE_LEASE_WAIT_MS = 15_000;
const MIN_POLL_MS = 25;
const MAX_POLL_MS = 500;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class WriteLease {
  readonly holder: string;
  readonly #port: WriteLeasePort;
  readonly #ttlMs: number;
  readonly #waitMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #depth = 0;

  constructor(port: WriteLeasePort, opts: WriteLeaseOptions = {}) {
    this.#port = port;
    this.holder = opts.holder ?? crypto.randomUUID();
    this.#ttlMs = opts.ttlMs ?? WRITE_LEASE_TTL_MS;
    this.#waitMs = opts.waitMs ?? WRITE_LEASE_WAIT_MS;
    this.#sleep = opts.sleep ?? realSleep;
    this.#now = opts.now ?? Date.now;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#depth > 0) {
      this.#depth++;
      try {
        return await fn();
      } finally {
        this.#depth--;
      }
    }
    const held = await this.#acquire();
    this.#depth = 1;
    const stopRenewing = held ? this.#renewWhileRunning() : () => {};
    try {
      return await fn();
    } finally {
      this.#depth = 0;
      stopRenewing();
      if (held) {
        await this.#port.releaseWriteLease(this.holder).catch((e) => log.warn("write_lease_release_failed", { error: String(e) }));
      }
    }
  }

  // True when granted; false when the index couldn't be reached (proceed
  // unserialized). Throws WriteBusyError when another writer kept it too long.
  async #acquire(): Promise<boolean> {
    const started = this.#now();
    let poll = MIN_POLL_MS;
    while (true) {
      let res: Awaited<ReturnType<WriteLeasePort["acquireWriteLease"]>>;
      try {
        res = await this.#port.acquireWriteLease(this.holder, this.#ttlMs);
      } catch (e) {
        log.warn("write_lease_unavailable", { error: String(e) });
        return false;
      }
      if (res.granted) return true;
      const waited = this.#now() - started;
      const left = this.#waitMs - waited;
      if (left <= 0) {
        log.warn("write_lease_busy", { waitedMs: waited });
        throw new WriteBusyError(waited);
      }
      await this.#sleep(Math.min(poll, res.retryInMs, left));
      poll = Math.min(poll * 2, MAX_POLL_MS);
    }
  }

  #renewWhileRunning(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = () => {
      timer = setTimeout(async () => {
        if (stopped) return;
        try {
          const res = await this.#port.acquireWriteLease(this.holder, this.#ttlMs);
          // Lost: our lease expired and another writer holds it now. The work
          // can't be undone mid-flight; say so and stop renewing.
          if (!res.granted) {
            log.warn("write_lease_lost", { holder: this.holder });
            return;
          }
        } catch (e) {
          log.warn("write_lease_renew_failed", { error: String(e) });
        }
        if (!stopped) tick();
      }, Math.max(Math.floor(this.#ttlMs / 3), 1));
    };
    tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }
}
