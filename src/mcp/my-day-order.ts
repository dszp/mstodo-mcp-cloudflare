// Pure helpers for My Day reordering. My Day is a CROSS-LIST aggregation, so the
// neighbor set for a My Day reorder is every INCOMPLETE task committed to the
// target day across ALL lists (keyed by CommittedOrder) — unlike reorder_task,
// whose neighbors live in one folder. The reorder tool reads that set straight
// from the SQLite cache (queryMyDayForDate), which has ALREADY filtered to the
// day and dropped postponed tasks; these helpers therefore do NO day-filtering.
// They only drop the mover, drop completed tasks, and read committed_order. The
// ms math (computeReorder/orderToMs/msToOrder) is reused verbatim from ./reorder
// — it is field-agnostic.
import { orderToMs } from "./reorder";

// We only ever read these three columns, so accept the minimal structural shape
// (a subset of cache/sql.ts TaskRow) — keeps callers and tests honest without
// fabricating whole rows. Status is Graph-cased ("completed"/"notStarted"/…),
// the value the cache stores from Graph delta.
export interface MyDayOrderRow {
  task_id: string;
  status: string;
  committed_order: string | null;
}

// To Do drops completed My Day items into a separate section, so they must not
// distort positional math. Compare case-insensitively against Graph's
// "completed".
export function isIncompleteRow(row: { status: string }): boolean {
  return (row.status ?? "").toLowerCase() !== "completed";
}

// CommittedOrder values (epoch ms) of every incomplete neighbor, minus the
// moving task, with null/unparseable orders dropped (no comparable position).
// Feed straight into computeReorder.
export function collectMyDayNeighborOrders(
  rows: MyDayOrderRow[],
  excludeTaskId: string,
): number[] {
  return rows
    .filter((r) => r.task_id !== excludeTaskId && isIncompleteRow(r))
    .map((r) => orderToMs(r.committed_order))
    .filter((ms): ms is number => ms !== null);
}

// Locate a row in the day's My Day set by Graph task id — used both to confirm
// the mover is on My Day and to read a before/after reference's committed_order.
// Returns null if absent (i.e. not on My Day for the day, per the cache).
export function findMyDayRowById<T extends { task_id: string }>(
  rows: T[],
  taskId: string,
): T | null {
  return rows.find((r) => r.task_id === taskId) ?? null;
}
