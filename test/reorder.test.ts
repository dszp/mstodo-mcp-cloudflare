import { describe, it, expect } from "vitest";
import {
  ORDER_NUDGE_MS,
  orderToMs,
  msToOrder,
  computeReorder,
  type ReorderSpec,
} from "../src/mcp/reorder";

// Pure manual-ordering math for reorder_task. OrderDateTime is the To Do
// manual-sort field (higher = nearer the top). These tests pin the arithmetic
// (top/bottom nudges, midpoint inserts, the precision-exhaustion guard) without
// any Substrate I/O — the tool layer wires getTask/listFolderTasks/patchTask
// around this.

const NOW = 1_700_000_000_000; // fixed clock for empty-folder cases
const now = () => NOW;

// A descending set of OrderDateTime values (ms) for "other" tasks in a folder.
// 50s apart so midpoints have room.
const T = (s: number) => 1_000_000_000_000 + s * 1000;
const ORDERS = [T(300), T(250), T(200), T(150), T(100)]; // top → bottom

function expectOk(r: ReturnType<typeof computeReorder>): number {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.ms;
}

describe("orderToMs / msToOrder", () => {
  it("round-trips an ISO timestamp through ms", () => {
    const iso = "2026-05-27T14:03:00.000Z";
    const ms = orderToMs(iso)!;
    expect(msToOrder(ms)).toBe(iso);
  });
  it("orderToMs returns null for null or unparseable input", () => {
    expect(orderToMs(null)).toBeNull();
    expect(orderToMs("not-a-date")).toBeNull();
  });
  it("msToOrder emits UTC ISO 8601 with millisecond precision", () => {
    expect(msToOrder(NOW)).toBe(new Date(NOW).toISOString());
  });
});

describe("computeReorder — top / bottom", () => {
  it("top places one nudge above the current max", () => {
    expect(expectOk(computeReorder({ kind: "top" }, ORDERS, now))).toBe(T(300) + ORDER_NUDGE_MS);
  });
  it("bottom places one nudge below the current min", () => {
    expect(expectOk(computeReorder({ kind: "bottom" }, ORDERS, now))).toBe(T(100) - ORDER_NUDGE_MS);
  });
  it("top on an empty folder uses the clock", () => {
    expect(expectOk(computeReorder({ kind: "top" }, [], now))).toBe(NOW);
  });
  it("bottom on an empty folder uses the clock", () => {
    expect(expectOk(computeReorder({ kind: "bottom" }, [], now))).toBe(NOW);
  });
  it("does not assume the input is pre-sorted", () => {
    const shuffled = [T(100), T(300), T(200)];
    expect(expectOk(computeReorder({ kind: "top" }, shuffled, now))).toBe(T(300) + ORDER_NUDGE_MS);
    expect(expectOk(computeReorder({ kind: "bottom" }, shuffled, now))).toBe(
      T(100) - ORDER_NUDGE_MS,
    );
  });
});

describe("computeReorder — index (1-based)", () => {
  it("index 1 behaves like top", () => {
    expect(expectOk(computeReorder({ kind: "index", index: 1 }, ORDERS, now))).toBe(
      T(300) + ORDER_NUDGE_MS,
    );
  });
  it("index past the end behaves like bottom", () => {
    expect(expectOk(computeReorder({ kind: "index", index: 99 }, ORDERS, now))).toBe(
      T(100) - ORDER_NUDGE_MS,
    );
  });
  it("index 3 lands between the 2nd and 3rd existing tasks", () => {
    // others sorted desc: [300,250,200,150,100]; position 3 => between 250 and 200
    const mid = Math.floor((T(250) + T(200)) / 2);
    expect(expectOk(computeReorder({ kind: "index", index: 3 }, ORDERS, now))).toBe(mid);
  });
});

describe("computeReorder — before / after a reference", () => {
  it("before a middle reference = midpoint between the reference and the task above it", () => {
    // reference at 200; task above is 250 => midpoint(250,200)
    const mid = Math.floor((T(250) + T(200)) / 2);
    expect(expectOk(computeReorder({ kind: "before", referenceMs: T(200) }, ORDERS, now))).toBe(mid);
  });
  it("before the top reference nudges above it", () => {
    expect(expectOk(computeReorder({ kind: "before", referenceMs: T(300) }, ORDERS, now))).toBe(
      T(300) + ORDER_NUDGE_MS,
    );
  });
  it("after a middle reference = midpoint between the reference and the task below it", () => {
    // reference at 200; task below is 150 => midpoint(200,150)
    const mid = Math.floor((T(200) + T(150)) / 2);
    expect(expectOk(computeReorder({ kind: "after", referenceMs: T(200) }, ORDERS, now))).toBe(mid);
  });
  it("after the bottom reference nudges below it", () => {
    expect(expectOk(computeReorder({ kind: "after", referenceMs: T(100) }, ORDERS, now))).toBe(
      T(100) - ORDER_NUDGE_MS,
    );
  });
  it("ignores the reference's own value among the orders (duplicate-safe neighbor search)", () => {
    // reference value also present in orders; before should still find 250 above.
    const withDup = [T(300), T(250), T(200), T(200), T(150)];
    const mid = Math.floor((T(250) + T(200)) / 2);
    expect(expectOk(computeReorder({ kind: "before", referenceMs: T(200) }, withDup, now))).toBe(
      mid,
    );
  });
});

describe("computeReorder — precision exhaustion", () => {
  it("returns order_precision_exhausted when neighbors are 1ms apart", () => {
    const tight = [T(200), T(200) - 1]; // adjacent ms, no value strictly between
    const r = computeReorder({ kind: "index", index: 2 }, tight, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("order_precision_exhausted");
  });
  it("returns order_precision_exhausted for after when the task below is 1ms away", () => {
    const tight = [T(200), T(200) - 1]; // nearest task below the reference is 1ms off
    const r = computeReorder({ kind: "after", referenceMs: T(200) }, tight, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("order_precision_exhausted");
  });
});
