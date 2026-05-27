// Pure manual-ordering math for the reorder_task tool.
//
// Microsoft To Do's manual (drag-to-reorder) position is backed by the
// Substrate-only `OrderDateTime` field: a higher value sorts nearer the TOP of
// the list. Reordering a task therefore means computing a new OrderDateTime
// relative to its neighbors and PATCHing it. This module owns that arithmetic
// only — all Substrate I/O (listFolderTasks / getTask / patchTask) lives in the
// tool layer, which feeds the neighbours' values in and serializes the result.
//
// Everything here works in integer milliseconds (JS `Date` resolution). The
// caller parses OrderDateTime strings to ms with orderToMs() and formats the
// result back with msToOrder().

// Gap left when placing a task at an edge (top/bottom), so a later midpoint
// insert near that edge still has room. The exact size is irrelevant to
// correctness — any value above the max (or below the min) lands at the edge.
export const ORDER_NUDGE_MS = 60_000;

export type ReorderSpec =
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "before"; referenceMs: number }
  | { kind: "after"; referenceMs: number }
  | { kind: "index"; index: number };

export type ComputeResult =
  | { ok: true; ms: number }
  | { ok: false; reason: "order_precision_exhausted" };

// Parse an OrderDateTime string to epoch ms, or null if absent/unparseable.
export function orderToMs(order: string | null | undefined): number | null {
  if (order == null) return null;
  const ms = Date.parse(order);
  return Number.isNaN(ms) ? null : ms;
}

// Format epoch ms as the wire OrderDateTime (UTC ISO 8601, ms precision).
export function msToOrder(ms: number): string {
  return new Date(ms).toISOString();
}

// Midpoint between two ms values, or precision-exhausted when no integer ms lies
// strictly between them (gap <= 1ms / duplicates).
function midpoint(hi: number, lo: number): ComputeResult {
  const mid = Math.floor((hi + lo) / 2);
  if (mid <= lo || mid >= hi) return { ok: false, reason: "order_precision_exhausted" };
  return { ok: true, ms: mid };
}

// Compute the new OrderDateTime (in ms) for a reorder. `orders` is the set of
// OrderDateTime values (ms) of the OTHER tasks in the folder (the moving task
// and any null-order tasks excluded); it need not be sorted. `now` is injected
// for testability (empty-folder edge cases).
export function computeReorder(
  spec: ReorderSpec,
  orders: number[],
  now: () => number = Date.now,
): ComputeResult {
  const sorted = [...orders].sort((a, b) => b - a); // descending: top first
  const count = sorted.length;
  const max = count ? sorted[0] : null;
  const min = count ? sorted[count - 1] : null;

  switch (spec.kind) {
    case "top":
      return { ok: true, ms: max === null ? now() : max + ORDER_NUDGE_MS };
    case "bottom":
      return { ok: true, ms: min === null ? now() : min - ORDER_NUDGE_MS };
    case "index": {
      if (spec.index <= 1 || count === 0) {
        return { ok: true, ms: max === null ? now() : max + ORDER_NUDGE_MS };
      }
      if (spec.index > count) {
        return { ok: true, ms: (min as number) - ORDER_NUDGE_MS };
      }
      // 1-based position p (2..count): between the (p-1)th and pth tasks.
      return midpoint(sorted[spec.index - 2], sorted[spec.index - 1]);
    }
    case "before": {
      // Place immediately above the reference: between it and the nearest task
      // with a strictly greater OrderDateTime. Value-based search is
      // duplicate-safe (the reference's own value may appear in `orders`).
      const above = sorted.filter((o) => o > spec.referenceMs);
      if (above.length === 0) return { ok: true, ms: spec.referenceMs + ORDER_NUDGE_MS };
      return midpoint(above[above.length - 1], spec.referenceMs);
    }
    case "after": {
      // Place immediately below the reference: between it and the nearest task
      // with a strictly lesser OrderDateTime.
      const below = sorted.filter((o) => o < spec.referenceMs);
      if (below.length === 0) return { ok: true, ms: spec.referenceMs - ORDER_NUDGE_MS };
      return midpoint(spec.referenceMs, below[0]);
    }
  }
}
