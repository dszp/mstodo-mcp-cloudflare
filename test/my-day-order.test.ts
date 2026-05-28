import { describe, it, expect } from "vitest";
import {
  isIncompleteRow,
  collectMyDayNeighborOrders,
  findMyDayRowById,
} from "../src/mcp/my-day-order";

// The reorder neighbor helpers operate on cache rows (TaskRow) returned by
// queryMyDayForDate(day), which has ALREADY filtered to committed_day == day
// AND not postponed. So these helpers do no day-filtering — they only drop the
// mover, drop completed tasks, and read committed_order. Status is Graph-cased
// (lowercase "completed"/"notStarted"), the shape the cache stores.
type Row = { task_id: string; status: string; committed_order: string | null };
const row = (task_id: string, status: string, committed_order: string | null): Row => ({
  task_id,
  status,
  committed_order,
});

describe("isIncompleteRow", () => {
  it("treats Graph-cased completed (any case) as not incomplete", () => {
    expect(isIncompleteRow(row("a", "completed", null))).toBe(false);
    expect(isIncompleteRow(row("a", "Completed", null))).toBe(false);
    expect(isIncompleteRow(row("a", "notStarted", null))).toBe(true);
    expect(isIncompleteRow(row("a", "inProgress", null))).toBe(true);
  });
});

describe("collectMyDayNeighborOrders", () => {
  const rows = [
    row("a", "notStarted", "2026-05-27T05:00:00Z"),
    row("b", "notStarted", "2026-05-27T04:00:00Z"),
    row("moving", "notStarted", "2026-05-27T03:00:00Z"),
    row("done", "completed", "2026-05-27T06:00:00Z"),
    row("no-order", "notStarted", null),
  ];

  it("keeps only incomplete, ordered tasks and excludes the mover", () => {
    const orders = collectMyDayNeighborOrders(rows, "moving");
    expect(orders.sort((x, y) => y - x)).toEqual([
      Date.parse("2026-05-27T05:00:00Z"),
      Date.parse("2026-05-27T04:00:00Z"),
    ]);
  });

  it("drops null/unparseable committed_order values", () => {
    const orders = collectMyDayNeighborOrders(
      [row("a", "notStarted", null), row("b", "notStarted", "not-a-date")],
      "moving",
    );
    expect(orders).toEqual([]);
  });

  it("returns empty when the mover is the only row", () => {
    expect(collectMyDayNeighborOrders([rows[2]], "moving")).toEqual([]);
  });
});

describe("findMyDayRowById", () => {
  const rows = [
    row("ref", "notStarted", "2026-05-27T04:00:00Z"),
    row("other", "completed", "2026-05-27T02:00:00Z"),
  ];
  it("finds a row by task_id", () => {
    expect(findMyDayRowById(rows, "ref")?.committed_order).toBe("2026-05-27T04:00:00Z");
  });
  it("returns null when absent", () => {
    expect(findMyDayRowById(rows, "missing")).toBeNull();
  });
});
