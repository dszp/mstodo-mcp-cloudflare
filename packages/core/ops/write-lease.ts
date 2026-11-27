import { log } from "../log";
import type { IndexBackend } from "../ports";

// The single write queue (docs/SYNC-API.md section 18.4), client side.
//
// Every op in src/core/ops runs inside ctx.writes.run(), so an MCP tool, a sync
// mutation and (later) an n8n route never interleave their Graph/Substrate
// calls. Each Graph call yields, so without this a retried sync batch, a second
// device and an MCP tool could all be mid-write on the same task at once.
//
// Topology: the ops run where the request is — the per-session McpAgent on
// Cloudflare, the request handler on Node — and only the index (the TodoIndex
// Durable Object, or IndexCore in process) is shared. A closure can't cross DO
// RPC, so the queue is a lease held by the index (IndexCore.acquireWriteLease),
// which also does the waiting: pending acquires queue FIFO inside the index and
// the call returns when the lease is ours or the wait ran out. This class:
//
//   - acquires with the whole wait budget (one RPC that waits server-side),
//     re-asking only if the index clamped the wait shorter or a call failed
//     mid-wait; out of budget → WriteBusyError (`write_busy`, retryable).
//   - renews every ~ttl/3 while the work runs (TTL 10 s), so a long write keeps
//     the lease and a dead writer frees it within seconds.
//   - releases in `finally`; a failed release is logged and the TTL covers it.
//   - serializes its own run() calls: one WriteLease is one writer, so two
//     concurrent run() calls on it queue behind each other locally rather than
//     sharing one lease. To hold the lease across several ops (a sync batch
//     around its mutations), use hold(): the ops get a `held` queue that runs
//     inline. Calling run() from inside run() on the same instance deadlocks.
//
// If the FIRST acquire can't reach the index, the write proceeds unserialized
// and logs `write_lease_unavailable` — the behavior before the queue existed;
// refusing every write while the index is unreachable would turn a consistency
// feature into an outage. Once the index has answered, a later failure is
// retried within the wait and ends in WriteBusyError, never an unserialized
// write.

export type WriteLeasePort = Pick<IndexBackend, "acquireWriteLease" | "releaseWriteLease">;

// What an op needs: run this write in the queue.
export interface WriteQueue {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

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

export const WRITE_LEASE_TTL_MS = 10_000;
// Long enough for a burst of parallel tool calls, each a few Graph calls, plus
// a throttled (429) write ahead in the queue; under an MCP client's timeout.
export const WRITE_LEASE_WAIT_MS = 50_000;
const RETRY_AFTER_ERROR_MS = 250;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class WriteLease implements WriteQueue {
  readonly holder: string;
  readonly #port: WriteLeasePort;
  readonly #ttlMs: number;
  readonly #waitMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(port: WriteLeasePort, opts: WriteLeaseOptions = {}) {
    this.#port = port;
    this.holder = opts.holder ?? crypto.randomUUID();
    this.#ttlMs = opts.ttlMs ?? WRITE_LEASE_TTL_MS;
    this.#waitMs = opts.waitMs ?? WRITE_LEASE_WAIT_MS;
    this.#sleep = opts.sleep ?? realSleep;
    this.#now = opts.now ?? Date.now;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#chain.then(() => this.#runHeld(fn));
    this.#chain = p.catch(() => undefined);
    return p;
  }

  // Holds the lease for all of fn; ops given `held` run inline under it.
  // `held` is only valid until fn settles.
  hold<T>(fn: (held: WriteQueue) => Promise<T>): Promise<T> {
    return this.run(() => fn({ run: (g) => g() }));
  }

  async #runHeld<T>(fn: () => Promise<T>): Promise<T> {
    const held = await this.#acquire();
    const stopRenewing = held ? this.#renewWhileRunning() : () => {};
    try {
      return await fn();
    } finally {
      stopRenewing();
      if (held) {
        await this.#port.releaseWriteLease(this.holder).catch((e) => log.warn("write_lease_release_failed", { error: String(e) }));
      }
    }
  }

  // True when granted; false when the first call couldn't reach the index
  // (proceed unserialized). Throws WriteBusyError when the wait runs out.
  async #acquire(): Promise<boolean> {
    const started = this.#now();
    let first = true;
    while (true) {
      const left = this.#waitMs - (this.#now() - started);
      try {
        const res = await this.#port.acquireWriteLease(this.holder, this.#ttlMs, Math.max(left, 0));
        if (res.granted) return true;
        // Refused with budget left (the index clamped the wait): ask again,
        // without spinning.
        if (this.#waitMs - (this.#now() - started) > 0) await this.#sleep(RETRY_AFTER_ERROR_MS);
      } catch (e) {
        if (first) {
          log.warn("write_lease_unavailable", { error: String(e) });
          return false;
        }
        log.warn("write_lease_acquire_failed", { error: String(e) });
        if (this.#waitMs - (this.#now() - started) > 0) await this.#sleep(RETRY_AFTER_ERROR_MS);
      }
      first = false;
      const waited = this.#now() - started;
      if (waited >= this.#waitMs) {
        log.warn("write_lease_busy", { waitedMs: waited });
        throw new WriteBusyError(waited);
      }
    }
  }

  #renewWhileRunning(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = () => {
      timer = setTimeout(async () => {
        if (stopped) return;
        try {
          const res = await this.#port.acquireWriteLease(this.holder, this.#ttlMs, 0);
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
