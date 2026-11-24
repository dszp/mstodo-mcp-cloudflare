import type { SubstrateTask } from "../graph/substrate-client";
import type { OpsContext } from "./context";
import { collectMyDayNeighborOrders, findMyDayRowById } from "./my-day-order";
import { computeOrder, type ReorderPosition } from "./position";
import { orderToMs } from "./reorder";
import { err, ok, type ToolResult } from "./result";

// myday.add / myday.remove / myday.reorder (docs/SYNC-API.md section 5.2). My
// Day is invisible to Graph: membership is the Substrate task's CommittedDay
// and its order is CommittedOrder. Callers gate on ENABLE_MY_DAY.
//
// The cache write-throughs here are NOT best-effort, unlike the Graph ops':
// a failure propagates, as it always has for these tools.

const MY_DAY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "Today" as YYYY-MM-DD in the owner's TIMEZONE. CommittedDay is a local
// calendar date and the server runs in UTC. en-CA formats as YYYY-MM-DD.
export function todayInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// `date` defaulted to today and validated.
function myDayDate(ctx: OpsContext, date: string | undefined): ToolResult<string> {
  const day = date ?? todayInTimeZone(ctx.env.TIMEZONE);
  if (!MY_DAY_DATE_RE.test(day)) return err("invalid_date", { date: day, hint: "Use YYYY-MM-DD." });
  return ok(day);
}

// Substrate echoes CommittedDay as a full ISO datetime; membership compares dates.
export function committedDatePart(committed: string | null | undefined): string | null {
  return committed ? committed.slice(0, 10) : null;
}

export type MyDayResult = { list_id: string; task_id: string; day: string; task: SubstrateTask };

// Puts the task on My Day for `date` (default today) at the TOP of My Day:
// CommittedOrder = now, which is above every existing value, so re-adding a
// task also bumps it to the top. Clears PostponedDay, which would otherwise
// hide the task for that day (what the official client does).
export function addToMyDay(
  ctx: OpsContext,
  input: { list_id: string; task_id: string; date?: string },
): Promise<ToolResult<MyDayResult>> {
  const { list_id, task_id } = input;
  return ctx.writes.run(async () => {
    const day = myDayDate(ctx, input.date);
    if (!day.ok) return day;
    const committedOrder = new Date().toISOString();
    const sub = await ctx.substrate();
    const task = await sub.patchTask(list_id, task_id, {
      CommittedDay: day.value,
      PostponedDay: null,
      CommittedOrder: committedOrder,
    });
    // Mirror what Substrate echoed, falling back to what was sent (it
    // occasionally omits an echoed field).
    await ctx.index.updateMyDayFields(task_id, {
      committed_day: task.CommittedDay ? task.CommittedDay.slice(0, 10) : day.value,
      postponed_day: task.PostponedDay ? task.PostponedDay.slice(0, 10) : null,
      order_datetime: task.OrderDateTime ?? null,
      committed_order: task.CommittedOrder ?? committedOrder,
    });
    return ok({ list_id, task_id, day: day.value, task });
  });
}

// Clears CommittedDay. The list's manual order (OrderDateTime) is independent
// of My Day and stays; PostponedDay is mirrored from the echo (the app sets it
// to today on removal).
export function removeFromMyDay(
  ctx: OpsContext,
  input: { list_id: string; task_id: string },
): Promise<ToolResult<{ list_id: string; task_id: string; task: SubstrateTask }>> {
  const { list_id, task_id } = input;
  return ctx.writes.run(async () => {
    const sub = await ctx.substrate();
    const task = await sub.patchTask(list_id, task_id, { CommittedDay: null });
    await ctx.index.updateMyDayFields(task_id, {
      committed_day: null,
      committed_order: null,
      postponed_day: task.PostponedDay ? task.PostponedDay.slice(0, 10) : null,
    });
    return ok({ list_id, task_id, task });
  });
}

// Moves the task within My Day for `date`. My Day spans lists, so neighbors are
// the day's incomplete My Day tasks read from the cache (the set
// list_my_day_tasks shows) and the only Substrate call is the write. The task,
// and any reference, must already be on My Day for that day — except for `set`,
// which writes the raw value with no membership check.
export function reorderMyDayTask(
  ctx: OpsContext,
  input: { list_id: string; task_id: string; date?: string; position: ReorderPosition },
): Promise<ToolResult<MyDayResult & { committed_order: string }>> {
  const { list_id, task_id, position } = input;
  return ctx.writes.run(async () => {
    const day = myDayDate(ctx, input.date);
    if (!day.ok) return day;
    let newOrder: string;
    if (position.kind === "set") {
      if (orderToMs(position.order) === null) return err("invalid_order", { order: position.order, hint: "Use an ISO 8601 timestamp." });
      newOrder = position.order;
    } else {
      const { rows } = await ctx.index.queryMyDayForDate(day.value);
      if (!findMyDayRowById(rows, task_id)) {
        return err("task_not_on_my_day", {
          task_id,
          date: day.value,
          hint: "Add the task to My Day for this date first (add_to_my_day), pass the correct `date`, or wait for the My Day cache to warm.",
        });
      }
      const computed = await computeOrder(position, {
        neighbors: () => collectMyDayNeighborOrders(rows, task_id),
        reference: async (id) => {
          const ref = findMyDayRowById(rows, id);
          return ref ? ok(ref.committed_order) : err("reference_not_on_my_day", { reference_task_id: id, date: day.value });
        },
        noOrder: (id) =>
          err("reference_has_no_committed_order", {
            reference_task_id: id,
            hint: "The reference task has no My Day order; move it first (e.g. position 'top').",
          }),
      });
      if (!computed.ok) return computed;
      newOrder = computed.value;
    }
    const sub = await ctx.substrate();
    const task = await sub.patchTask(list_id, task_id, { CommittedOrder: newOrder });
    await ctx.index.updateMyDayFields(task_id, { committed_order: newOrder });
    return ok({ list_id, task_id, day: day.value, task, committed_order: newOrder });
  });
}
