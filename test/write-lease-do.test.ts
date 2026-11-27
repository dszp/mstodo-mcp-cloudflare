// The write lease over real Durable Object RPC: the McpAgent Worker reaches the
// TodoIndex singleton through a stub, so the lease's results must survive
// structured cloning and its state must be shared across callers.
import { describe, it, expect } from "vitest";
import { ownerIndex } from "../src/core/owner-index";
import { WriteLease } from "../src/core/ops/write-lease";
import { testAppEnv } from "./_app-env";

describe("write lease on the TodoIndex Durable Object", () => {
  it("grants one holder at a time and frees on release", async () => {
    const index = ownerIndex(testAppEnv());
    expect(await index.acquireWriteLease("a", 5_000)).toMatchObject({ granted: true });
    expect(await index.acquireWriteLease("b", 5_000)).toEqual({ granted: false });
    expect(await index.releaseWriteLease("b")).toBe(false);
    expect(await index.releaseWriteLease("a")).toBe(true);
    expect(await index.acquireWriteLease("b", 5_000)).toMatchObject({ granted: true });
    // A waiter's wait crosses RPC: it resolves when the holder releases.
    const waiting = index.acquireWriteLease("c", 5_000, 5_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(await index.releaseWriteLease("b")).toBe(true);
    expect(await waiting).toMatchObject({ granted: true });
    expect(await index.releaseWriteLease("c")).toBe(true);
  });

  it("serializes two WriteLease runs through the stub", async () => {
    const index = ownerIndex(testAppEnv());
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const first = new WriteLease(index).run(async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });
    // Let the first acquire land before the second starts polling.
    while (!events.length) await new Promise((r) => setTimeout(r, 5));
    const second = new WriteLease(index).run(async () => {
      events.push("second:start");
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });
});
