// The single write queue (docs/SYNC-API.md section 18.4): the lease IndexCore
// holds, and WriteLease, the side that waits for it, renews it and releases it.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";
import { WriteBusyError, WriteLease, type WriteLeasePort } from "../src/core/ops/write-lease";

function core() {
  const db = openDatabase(":memory:");
  const state = stateStore(db);
  const c = new IndexCore({ sql: sqlDb(db), transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  return c;
}

// IndexCore as the port, async like the DO stub / Node proxy.
const port = (c: IndexCore): WriteLeasePort => ({
  acquireWriteLease: async (h, t) => c.acquireWriteLease(h, t),
  releaseWriteLease: async (h) => c.releaseWriteLease(h),
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
  it("refuses a second holder until the first releases", () => {
    const c = core();
    expect(c.acquireWriteLease("a", 10_000)).toMatchObject({ granted: true });
    expect(c.acquireWriteLease("b", 10_000)).toEqual({ granted: false, retryInMs: expect.any(Number) });
    expect(c.releaseWriteLease("a")).toBe(true);
    expect(c.acquireWriteLease("b", 10_000)).toMatchObject({ granted: true });
  });

  it("lets only the holder release it", () => {
    const c = core();
    c.acquireWriteLease("a", 10_000);
    expect(c.releaseWriteLease("b")).toBe(false);
    expect(c.acquireWriteLease("b", 10_000).granted).toBe(false);
  });

  it("extends for the same holder and expires for everyone else", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const c = core();
    expect(c.acquireWriteLease("a", 10_000)).toEqual({ granted: true, expiresAt: 10_000 });
    vi.setSystemTime(8_000);
    expect(c.acquireWriteLease("a", 10_000)).toEqual({ granted: true, expiresAt: 18_000 });
    expect(c.acquireWriteLease("b", 10_000)).toEqual({ granted: false, retryInMs: 10_000 });
    vi.setSystemTime(18_000);
    expect(c.acquireWriteLease("b", 10_000)).toMatchObject({ granted: true });
    // The expired holder can't release the new owner's lease.
    expect(c.releaseWriteLease("a")).toBe(false);
  });

  it("clamps the TTL so no caller holds it indefinitely or for no time", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const c = core();
    expect(c.acquireWriteLease("a", 86_400_000)).toEqual({ granted: true, expiresAt: 120_000 });
    c.releaseWriteLease("a");
    expect(c.acquireWriteLease("a", 0)).toEqual({ granted: true, expiresAt: 1_000 });
    c.releaseWriteLease("a");
    expect(c.acquireWriteLease("a", Number.NaN)).toEqual({ granted: true, expiresAt: 1_000 });
  });
});

describe("WriteLease", () => {
  it("runs writers one at a time", async () => {
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

  it("gives up with WriteBusyError after the wait and never runs the write", async () => {
    const c = core();
    c.acquireWriteLease("other", 60_000);
    let t = 0;
    const lease = new WriteLease(port(c), {
      waitMs: 1_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    const fn = vi.fn(async () => "ran");
    const e = await lease.run(fn).catch((x) => x);
    expect(e).toBeInstanceOf(WriteBusyError);
    expect((e as WriteBusyError).reason).toBe("write_busy");
    expect(fn).not.toHaveBeenCalled();
    expect(t).toBeGreaterThanOrEqual(1_000);
  });

  it("is reentrant: a nested run on the same lease doesn't wait on itself", async () => {
    const c = core();
    const lease = new WriteLease(port(c), { waitMs: 100 });
    const out = await lease.run(async () => lease.run(async () => "inner"));
    expect(out).toBe("inner");
    // Released once the outer run finished.
    expect(c.acquireWriteLease("next", 1_000).granted).toBe(true);
  });

  it("releases when the write throws", async () => {
    const c = core();
    await expect(new WriteLease(port(c)).run(async () => Promise.reject(new Error("graph down")))).rejects.toThrow("graph down");
    expect(c.acquireWriteLease("next", 1_000).granted).toBe(true);
  });

  it("proceeds unserialized when the index can't be reached", async () => {
    const down: WriteLeasePort = {
      acquireWriteLease: async () => Promise.reject(new Error("DO unavailable")),
      releaseWriteLease: vi.fn(async () => true),
    };
    expect(await new WriteLease(down).run(async () => "ran")).toBe("ran");
    expect(down.releaseWriteLease).not.toHaveBeenCalled();
  });

  it("renews while a long write runs, so a waiter can't take it over", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const c = core();
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const run = new WriteLease(port(c), { ttlMs: 3_000 }).run(() => done);
    await vi.advanceTimersByTimeAsync(0);
    // Well past the original 3 s TTL: still held thanks to renewal every 1 s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.acquireWriteLease("waiter", 3_000).granted).toBe(false);
    finish();
    await run;
    expect(c.acquireWriteLease("waiter", 3_000).granted).toBe(true);
  });
});
