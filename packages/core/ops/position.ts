import { computeReorder, msToOrder, orderToMs, type ReorderSpec } from "./reorder";
import { err, ok, type ToolErr, type ToolResult } from "./result";

// Where to move an item in a manual order: what task.reorder, step.reorder and
// myday.reorder take. `set` writes a raw order value (a debug escape hatch);
// every other kind is converted to an order value against the server's own view
// of the neighbors, so callers never see To Do's descending-timestamp encoding
// (docs/SYNC-API.md section 5.2).
export type ReorderPosition =
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "before"; reference_id: string }
  | { kind: "after"; reference_id: string }
  | { kind: "index"; index: number }
  | { kind: "set"; order: string };

const NO_ROOM_HINT = "No room between neighbors at millisecond precision; use position 'top'/'bottom' to reset.";

// The order value for `position`. The sources are called lazily and in this
// order — neighbors, then the reference — so an op that has to fetch them
// (reorder_task reads the folder, then the reference task) fetches nothing for
// `set` and nothing it doesn't need.
//   neighbors: the OTHER items' order values in ms (the mover excluded,
//              unparseable values dropped — see orderValues()).
//   reference: the reference item's raw order, or the op's not-found error.
//   noOrder:   the op's error for a reference that has no order value yet.
export async function computeOrder(
  position: ReorderPosition,
  src: {
    neighbors: () => number[] | Promise<number[]>;
    reference: (id: string) => Promise<ToolResult<string | null>>;
    noOrder: (id: string) => ToolErr;
  },
): Promise<ToolResult<string>> {
  if (position.kind === "set") {
    if (orderToMs(position.order) === null) return err("invalid_order", { order: position.order, hint: "Use an ISO 8601 timestamp." });
    return ok(position.order);
  }
  const orders = await src.neighbors();
  let spec: ReorderSpec;
  if (position.kind === "before" || position.kind === "after") {
    const ref = await src.reference(position.reference_id);
    if (!ref.ok) return ref;
    const referenceMs = orderToMs(ref.value);
    if (referenceMs === null) return src.noOrder(position.reference_id);
    spec = { kind: position.kind, referenceMs };
  } else {
    spec = position;
  }
  const computed = computeReorder(spec, orders);
  if (!computed.ok) return err(computed.reason, { hint: NO_ROOM_HINT });
  return ok(msToOrder(computed.ms));
}

// Order values (ms) of the items that have one; null/unparseable ones have no
// comparable position and are dropped.
export function orderValues(orders: Array<string | null | undefined>): number[] {
  return orders.map(orderToMs).filter((ms): ms is number => ms !== null);
}
