// The single write queue (docs/SYNC-API.md section 18.4): the lease IndexCore
// holds (and the FIFO of writers waiting for it), and WriteLease, the side
// that acquires, renews and releases it.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";
import { WriteBusyError, WriteLease, type WriteLeasePort } from "../src/core/ops/write-lease";

function core(db = openDatabase(":memory:")) {
  const state = stateStore(db);
  const c = new IndexCore({ sql: sqlDb(db), transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  return c;
}

const port = (c: IndexCore): WriteLeasePort => ({
  acquireWriteLease: (h: string, t: number, w?: number) => c.acquireWriteLease(h, t, w),
  releaseWriteLease: (h: string) => c.releaseWriteLease(h),
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("IndexCore write lease", () => {
  it("refuses a second holder without a wait, and frees on release", async () => {
    const c = core();
    expect(await c.acquireWriteLease("a", 10_000)).toMatchObject({ granted: true });
    expect(await c.acquireWriteLease("b", 10_000)).toEqual({ granted: false });
    expect(await c.releaseWriteLease("b")).toBe(false);
    expect(await c.releaseWriteLease("a")).toBe(true);
    expect(await c.acquireWriteLease("b", 10_000)).toMatchObject({ granted: true });
  });

  it("hands the lease to waiters in arrival order", async () => {
    const c = core();
    await c.acquireWriteLease("a", 10_000);
    const order: string[] = [];
    const b = c.acquireWriteLease("b", 10_000, 5_000).then((r) => order.push(`b:${r.granted}`));
    const d = c.acquireWriteLease("d", 10_000, 5_000).then((r) => order.push(`d:${r.granted}`));
    await c.releaseWriteLease("a");
    // A newcomer can't jump the queue.
    expect(await c.acquireWriteLease("e", 10_000)).toEqual({ granted: false });
    await b;
    await c.releaseWriteLease("b");
    await d;
    expect(order).toEqual(["b:true", "d:true"]);
  });

  it("passes a dead holder's lease on at its expiry, and times a waiter out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const c = core();
    await c.acquireWriteLease("dead", 2_000);
    const next = c.acquireWriteLease("next", 2_000, 10_000);
    const late = c.acquireWriteLease("late", 2_000, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await late).toEqual({ granted: false });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await next).toMatchObject({ granted: true });
    // The expired holder can't release the new owner's lease.
    expect(await c.releaseWriteLease("dead")).toBe(false);
  });

  it("extends for the same holder and clamps the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const c = core();
    expect(await c.acquireWriteLease("a", 86_400_000)).toEqual({ granted: true, expiresAt: 120_000 });
    vi.setSystemTime(8_000);
    expect(await c.acquireWriteLease("a", 0)).toEqual({ granted: true, expiresAt: 9_000 });
    expect(await c.acquireWriteLease("b", Number.NaN)).toEqual({ granted: false });
  });

  it("survives a restart of the index (persisted in the state store)", async () => {
    const db = openDatabase(":memory:");
    await core(db).acquireWriteLease("a", 10_000);
    const restarted = core(db);
    expect(await restarted.acquireWriteLease("b", 10_000)).toEqual({ granted: false });
    expect(await restarted.releaseWriteLease("a")).toBe(true);
    expect(await core(db).acquireWriteLease("b", 10_000)).toMatchObject({ granted: true });
  });
});

describe("WriteLease", () => {
  it("runs writers one at a time, queued in the index", async () => {
    const c = core();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const first = new WriteLease(port(c)).run(async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
      return 1;
    });
    await vi.waitFor(() => expect(events).toEqual(["first:start"]));
    const second = new WriteLease(port(c)).run(async () => {
      events.push("second:start");
      return 2;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("lets a burst of 20 writers through, one at a time, without write_busy", async () => {
    const c = core();
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        new WriteLease(port(c)).run(async () => {
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return i;
        }),
      ),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it("gives up with WriteBusyError after the wait and never runs the write", async () => {
    vi.useFakeTimers();
    const c = core();
    await c.acquireWriteLease("other", 60_000);
    const fn = vi.fn(async () => "ran");
    const run = new WriteLease(port(c), { waitMs: 1_000 }).run(fn).catch((x) => x);
    await vi.advanceTimersByTimeAsync(1_500);
    const e = await run;
    expect(e).toBeInstanceOf(WriteBusyError);
    expect((e as WriteBusyError).reason).toBe("write_busy");
    expect(fn).not.toHaveBeenCalled();
  });

  it("serializes concurrent run() calls on one instance; hold() runs ops inline", async () => {
    const c = core();
    const lease = new WriteLease(port(c), { waitMs: 200 });
    const events: string[] = [];
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    const a = lease.run(async () => {
      events.push("a:start");
      await gate;
      events.push("a:end");
    });
    const b = lease.run(async () => {
      events.push("b");
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(["a:start"]);
    releaseA();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b"]);
    expect(await lease.hold(async (held) => held.run(async () => "inner"))).toBe("inner");
    expect((await c.acquireWriteLease("next", 1_000)).granted).toBe(true);
  });

  it("releases when the write throws", async () => {
    const c = core();
    await expect(new WriteLease(port(c)).run(async () => Promise.reject(new Error("graph down")))).rejects.toThrow("graph down");
    expect((await c.acquireWriteLease("next", 1_000)).granted).toBe(true);
  });

  it("proceeds unserialized only when the FIRST acquire can't reach the index", async () => {
    const down: WriteLeasePort = {
      acquireWriteLease: async () => Promise.reject(new Error("DO unavailable")),
      releaseWriteLease: vi.fn(async () => true),
    };
    expect(await new WriteLease(down).run(async () => "ran")).toBe("ran");
    expect(down.releaseWriteLease).not.toHaveBeenCalled();

    // Refused once, then unreachable: never unserialized — busy at the deadline.
    let t = 0;
    let calls = 0;
    const flaky: WriteLeasePort = {
      acquireWriteLease: async () => {
        t += 100;
        if (++calls === 1) return { granted: false };
        throw new Error("DO reset");
      },
      releaseWriteLease: async () => true,
    };
    const fn = vi.fn(async () => "ran");
    const e = await new WriteLease(flaky, { waitMs: 1_000, now: () => t, sleep: async (ms) => void (t += ms) }).run(fn).catch((x) => x);
    expect(e).toBeInstanceOf(WriteBusyError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("renews while a long write runs, so a waiter can't take it over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const c = core();
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const run = new WriteLease(port(c)).run(() => done);
    await vi.advanceTimersByTimeAsync(0);
    // Well past the 10 s TTL: still held thanks to renewal every ~3 s.
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await c.acquireWriteLease("waiter", 3_000)).granted).toBe(false);
    finish();
    await run;
    expect((await c.acquireWriteLease("waiter", 3_000)).granted).toBe(true);
  });
});
