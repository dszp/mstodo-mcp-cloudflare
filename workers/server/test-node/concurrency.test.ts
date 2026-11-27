// mapPool (packages/core/graph/concurrency.ts): bounded parallel Graph calls.
import { describe, it, expect } from "vitest";
import { mapPool } from "@potem/core/graph/concurrency";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("mapPool", () => {
  it("keeps results in input order whatever order they finish in", async () => {
    const out = await mapPool([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("never runs more than `limit` at once", async () => {
    let running = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      peak = Math.max(peak, ++running);
      await tick();
      running--;
    });
    expect(peak).toBe(3);
  });

  it("runs one at a time when the limit is below 1", async () => {
    let running = 0;
    let peak = 0;
    await mapPool([1, 2, 3], 0, async () => {
      peak = Math.max(peak, ++running);
      await tick();
      running--;
    });
    expect(peak).toBe(1);
  });

  it("returns [] for no items without calling fn", async () => {
    let calls = 0;
    expect(await mapPool([], 4, async () => ++calls)).toEqual([]);
    expect(calls).toBe(0);
  });

  it("passes each item's index", async () => {
    expect(await mapPool(["a", "b"], 2, async (x, i) => `${x}${i}`)).toEqual(["a0", "b1"]);
  });

  it("rejects when any call rejects", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
  });
});
