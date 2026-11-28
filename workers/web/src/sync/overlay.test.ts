import { describe, expect, it } from "vitest";
import type { FeedChange, FeedList, FeedStep, FeedTask } from "./feed";
import type { Mutation, Op } from "./mutation";
import { applyOptimistic } from "./overlay";
import { listTasks, searchLocal, smartListTasks } from "./smart-lists";
import { MirrorStore, type MirrorTask } from "./store";

const TODAY = "2026-11-27";
const CTX = { today: TODAY, defaultListId: "INBOX" };

function taskData(over: Partial<FeedTask> = {}): FeedTask {
  return {
    list_id: "L1", title: "T", status: "notStarted", body: null, importance: "normal", categories: [],
    due: null, start: null, reminder: { on: false, at: null }, completed_at: null, recurrence: null,
    created_at: "2026-11-01T10:00:00Z", modified_at: "2026-11-01T10:00:00Z", order: null,
    my_day: { committed_day: null, committed_order: null, postponed_day: null },
    subresources_complete: true, steps: [], links: [], attachments: [], ...over,
  };
}
function listData(over: Partial<FeedList> = {}): FeedList {
  return {
    name: "L", sync: "todo", wellknown: null, is_owner: true, is_shared: false, group_id: null,
    sort_key: null, theme: { color: null, background: null }, image_id: null, image_style: null, ...over,
  };
}
const step = (id: string, over: Partial<FeedStep> = {}): FeedStep => ({
  id, title: "S", checked: false, checked_at: null, created_at: "2026-11-01T10:00:00Z", order: null, ...over,
});
const base = (id: string, over: Partial<FeedTask> = {}): MirrorTask => ({ id, ...taskData(over) });

let seq = 0;
const task = (id: string, over: Partial<FeedTask> = {}): FeedChange => ({
  kind: "task", id, seq: ++seq, deleted: false, data: taskData(over), field_clock: {},
});
const list = (id: string): FeedChange => ({ kind: "list", id, seq: ++seq, deleted: false, data: listData() });

let mid = 0;
function mut(op: Op, sid: string, fields?: Record<string, unknown>): Mutation {
  mid += 1;
  return { id: `m${mid}`, at: `2026-11-27T12:00:${String(mid % 60).padStart(2, "0")}.000Z`, op, sid, ...(fields ? { fields } : {}) };
}
function store(...changes: FeedChange[]): MirrorStore {
  const s = new MirrorStore();
  s.applyPage([list("L1"), list("L2"), ...changes]);
  return s;
}
const ids = (ts: readonly { id: string }[]) => ts.map((t) => t.id);

describe("applyOptimistic", () => {
  it("task.create shows the given fields, notStarted, created now, at the top of its list", () => {
    const m = mut("task.create", "n1", { list_id: "L1", title: "New", importance: "high", due: "2026-11-30" });
    const t = applyOptimistic(undefined, m, { ...CTX, top: () => "9~" });
    expect(t).toMatchObject({
      id: "n1", list_id: "L1", title: "New", importance: "high", due: "2026-11-30",
      status: "notStarted", completed_at: null, created_at: m.at, order: "9~", steps: [],
    });
  });

  it("task.create without a list_id goes to the default list", () => {
    const t = applyOptimistic(undefined, mut("task.create", "n1", { title: "New" }), CTX);
    expect(t?.list_id).toBe("INBOX");
  });

  it("task.update shows the fields given", () => {
    const t = applyOptimistic(base("a"), mut("task.update", "a", { title: "B", importance: "high" }), CTX);
    expect(t).toMatchObject({ title: "B", importance: "high", status: "notStarted" });
  });

  it("task.update completed shows completed_at = today, notStarted clears it", () => {
    const done = applyOptimistic(base("a"), mut("task.update", "a", { status: "completed" }), CTX);
    expect(done).toMatchObject({ status: "completed", completed_at: TODAY });
    const undone = applyOptimistic(done!, mut("task.update", "a", { status: "notStarted" }), CTX);
    expect(undone).toMatchObject({ status: "notStarted", completed_at: null });
  });

  it("task.delete hides the task", () => {
    expect(applyOptimistic(base("a"), mut("task.delete", "a"), CTX)).toBeNull();
  });

  it("task.move shows the new list", () => {
    expect(applyOptimistic(base("a"), mut("task.move", "a", { list_id: "L2" }), CTX)?.list_id).toBe("L2");
  });

  it("myday.add shows today at the top; myday.remove clears the day", () => {
    const added = applyOptimistic(base("a"), mut("myday.add", "a"), { ...CTX, top: () => "5~" });
    expect(added?.my_day).toMatchObject({ committed_day: TODAY, committed_order: "5~" });
    const removed = applyOptimistic(added!, mut("myday.remove", "a"), CTX);
    expect(removed?.my_day.committed_day).toBeNull();
  });

  it("step.create, step.update and step.delete apply to the parent's steps", () => {
    const t0 = base("a", { steps: [step("s1")] });
    const c = mut("step.create", "s2", { task_id: "a", title: "Two", checked: false });
    const t1 = applyOptimistic(t0, c, CTX)!;
    expect(t1.steps).toEqual([step("s1"), { id: "s2", title: "Two", checked: false, checked_at: null, created_at: c.at, order: null }]);
    const u = mut("step.update", "s1", { checked: true, title: "One" });
    const t2 = applyOptimistic(t1, u, CTX)!;
    expect(t2.steps[0]).toMatchObject({ id: "s1", title: "One", checked: true, checked_at: u.at });
    const t3 = applyOptimistic(t2, mut("step.delete", "s1"), CTX)!;
    expect(ids(t3.steps)).toEqual(["s2"]);
  });

  it("returns undefined for another task's mutation and for ops it doesn't show", () => {
    expect(applyOptimistic(base("a"), mut("task.update", "b", { title: "X" }), CTX)).toBeUndefined();
    expect(applyOptimistic(base("a"), mut("step.update", "s9", { title: "X" }), CTX)).toBeUndefined();
    expect(applyOptimistic(base("a"), mut("step.create", "s9", { task_id: "b", title: "X" }), CTX)).toBeUndefined();
    expect(applyOptimistic(undefined, mut("task.update", "a", { title: "X" }), CTX)).toBeUndefined();
    expect(applyOptimistic(base("a"), mut("list.update", "L1", { name: "X" }), CTX)).toBeUndefined();
  });

  it("does not change its input", () => {
    const t0 = base("a", { steps: [step("s1")] });
    const snapshot = JSON.stringify(t0);
    applyOptimistic(t0, mut("task.update", "a", { status: "completed" }), CTX);
    applyOptimistic(t0, mut("step.update", "s1", { checked: true }), CTX);
    applyOptimistic(t0, mut("myday.add", "a"), CTX);
    expect(JSON.stringify(t0)).toBe(snapshot);
  });
});

describe("pending edits in the store", () => {
  it("apply in queue order: complete, then un-complete", () => {
    const s = store(task("a"));
    s.setPending([mut("task.update", "a", { status: "completed" }), mut("task.update", "a", { status: "notStarted" })], CTX);
    expect(s.task("a")).toMatchObject({ status: "notStarted", completed_at: null });
    s.setPending([mut("task.update", "a", { status: "notStarted" }), mut("task.update", "a", { status: "completed" })], CTX);
    expect(s.task("a")).toMatchObject({ status: "completed", completed_at: TODAY });
  });

  it("a create followed by an update to the same task", () => {
    const s = store();
    s.setPending([mut("task.create", "n1", { list_id: "L1", title: "Draft" }), mut("task.update", "n1", { title: "Final" })], CTX);
    expect(s.task("n1")?.title).toBe("Final");
    expect(ids(s.tasks())).toEqual(["n1"]);
    expect(s.baseTask("n1")).toBeUndefined();
  });

  it("a step created on a task that is itself pending creation, then updated", () => {
    const s = store();
    s.setPending([
      mut("task.create", "n1", { list_id: "L1", title: "New" }),
      mut("step.create", "s1", { task_id: "n1", title: "Step", checked: false }),
      mut("step.update", "s1", { checked: true }),
    ], CTX);
    expect(s.task("n1")?.steps).toMatchObject([{ id: "s1", title: "Step", checked: true }]);
  });

  it("a step update finds its parent among the mirror's tasks", () => {
    const s = store(task("a", { steps: [step("s1")] }), task("b"));
    s.setPending([mut("step.update", "s1", { title: "Renamed" })], CTX);
    expect(s.task("a")?.steps[0]?.title).toBe("Renamed");
    expect(s.task("b")).toBe(s.baseTask("b"));
  });

  it("a pending create sorts first in its list, newest first", () => {
    const s = store(task("a", { order: "2026-11-20T00:00:00.000Z" }), task("b", { order: "2026-11-25T00:00:00.000Z" }));
    s.setPending([mut("task.create", "n1", { list_id: "L1", title: "One" }), mut("task.create", "n2", { list_id: "L1", title: "Two" })], CTX);
    expect(ids(listTasks(s, "L1"))).toEqual(["n2", "n1", "b", "a"]);
    expect(ids(smartListTasks(s, "all", { today: TODAY }))).toEqual(["n2", "n1", "b", "a"]);
  });

  it("a pending create in an empty list still has an order", () => {
    const s = store();
    s.setPending([mut("task.create", "n1", { list_id: "L2", title: "One" })], CTX);
    expect(s.task("n1")?.order).not.toBeNull();
  });

  it("a pending myday.add shows in My Day, at the top", () => {
    const s = store(
      task("a", { my_day: { committed_day: TODAY, committed_order: "2026-11-27T08:00:00.000Z", postponed_day: null } }),
      task("b"),
    );
    expect(ids(smartListTasks(s, "my_day", { today: TODAY }))).toEqual(["a"]);
    s.setPending([mut("myday.add", "b")], CTX);
    expect(ids(smartListTasks(s, "my_day", { today: TODAY }))).toEqual(["b", "a"]);
  });

  it("pending deletes are hidden from smart lists and search", () => {
    const s = store(task("a", { title: "Example invoice", importance: "high" }), task("b", { title: "Example memo" }));
    s.setPending([mut("task.delete", "a")], CTX);
    expect(s.task("a")).toBeUndefined();
    expect(s.baseTask("a")).toBeDefined();
    expect(ids(smartListTasks(s, "all", { today: TODAY }))).toEqual(["b"]);
    expect(ids(smartListTasks(s, "important", { today: TODAY }))).toEqual([]);
    expect(ids(searchLocal(s, "example"))).toEqual(["b"]);
  });

  it("search sees a pending title", () => {
    const s = store(task("a", { title: "Old" }));
    s.setPending([mut("task.update", "a", { title: "Brand new" })], CTX);
    expect(ids(searchLocal(s, "brand"))).toEqual(["a"]);
    expect(ids(searchLocal(s, "old"))).toEqual([]);
  });

  it("after a pull the overlay is gone and the base wins", () => {
    const s = store(task("a", { title: "Before" }));
    const m = mut("task.update", "a", { title: "Mine" });
    s.setPending([m], CTX);
    expect(s.task("a")?.title).toBe("Mine");
    // The server applied it, then another device renamed it; the pull brings that.
    s.setPending([], CTX);
    s.applyPage([task("a", { title: "Theirs" })]);
    expect(s.task("a")?.title).toBe("Theirs");
    expect(s.task("a")).toBe(s.baseTask("a"));
  });

  it("a rejected mutation removed from the outbox stops applying", () => {
    const s = store(task("a", { title: "Server" }));
    const rejected = mut("task.delete", "a");
    const kept = mut("task.update", "a", { importance: "high" });
    s.setPending([rejected, kept], CTX);
    expect(s.task("a")).toBeUndefined();
    s.setPending([kept], CTX);
    expect(s.task("a")).toMatchObject({ title: "Server", importance: "high" });
  });
});
