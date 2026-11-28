import { describe, expect, it, vi } from "vitest";
import type { FeedChange, FeedList, FeedTask } from "./feed";
import type { Mutation, Op } from "./mutation";
import { smartListTasks } from "./smart-lists";
import { MirrorStore } from "./store";

function taskData(over: Partial<FeedTask> = {}): FeedTask {
  return {
    list_id: null,
    title: "T",
    status: "notStarted",
    body: null,
    importance: null,
    categories: [],
    due: null,
    start: null,
    reminder: { on: false, at: null },
    completed_at: null,
    recurrence: null,
    created_at: null,
    modified_at: null,
    order: null,
    my_day: { committed_day: null, committed_order: null, postponed_day: null },
    subresources_complete: true,
    steps: [],
    links: [],
    attachments: [],
    ...over,
  };
}
function listData(over: Partial<FeedList> = {}): FeedList {
  return {
    name: "L",
    sync: "todo",
    wellknown: null,
    is_owner: true,
    is_shared: false,
    group_id: null,
    sort_key: null,
    theme: { color: null, background: null },
    image_id: null,
    image_style: null,
    ...over,
  };
}
let seq = 0;
const task = (id: string, over: Partial<FeedTask> = {}): FeedChange => ({
  kind: "task", id, seq: ++seq, deleted: false, data: taskData(over), field_clock: {},
});
const list = (id: string, over: Partial<FeedList> = {}): FeedChange => ({
  kind: "list", id, seq: ++seq, deleted: false, data: listData(over),
});
const del = (kind: "task" | "list", id: string): FeedChange => ({ kind, id, seq: ++seq, deleted: true });

describe("MirrorStore", () => {
  it("replaces an entity with the newest data", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1", { title: "A" })]);
    s.applyPage([task("t1", { title: "B" })]);
    expect(s.task("t1")?.title).toBe("B");
    expect(s.task("t1")?.id).toBe("t1");
  });

  it("keeps a task whose list hasn't arrived", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1", { list_id: "L1" })]);
    expect(s.task("t1")).toBeDefined();
    const before = s.task("t1");
    s.applyPage([list("L1")]);
    expect(s.lists().map((l) => l.id)).toEqual(["L1"]);
    expect(s.task("t1")).toBe(before);
  });

  it("treats a deletion followed by the same id as an undelete", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1")]);
    s.applyPage([del("task", "t1")]);
    expect(s.task("t1")).toBeUndefined();
    s.applyPage([task("t1")]);
    expect(s.task("t1")).toBeDefined();
  });

  it("notifies only the changed task's subscribers", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1"), task("t2")]);
    const c1 = vi.fn(), c2 = vi.fn(), cAll = vi.fn();
    s.subscribe({ task: "t1" }, c1);
    s.subscribe({ task: "t2" }, c2);
    s.subscribe("tasks", cAll);
    s.applyPage([task("t1", { title: "X" })]);
    expect(c1).toHaveBeenCalledTimes(1);
    expect(c2).not.toHaveBeenCalled();
    expect(cAll).toHaveBeenCalledTimes(1);
  });

  it("notifies once per page", () => {
    const s = new MirrorStore();
    const cb = vi.fn();
    s.subscribe("tasks", cb);
    s.applyPage(Array.from({ length: 500 }, (_, i) => task(`t${i}`)));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("tasks() is referentially stable without changes", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1")]);
    const a = s.tasks();
    expect(s.tasks()).toBe(a);
    s.applyPage([list("L1")]);
    expect(s.tasks()).toBe(a);
    s.applyPage([task("t1", { title: "Z" })]);
    expect(s.tasks()).not.toBe(a);
  });

  it("bumps version only for keys whose data changed", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1")]);
    const vt = s.version("tasks"), vl = s.version("lists"), v1 = s.version({ task: "t1" });
    s.applyPage([list("L1")]);
    expect(s.version("tasks")).toBe(vt);
    expect(s.version("lists")).toBeGreaterThan(vl);
    expect(s.version({ task: "t1" })).toBe(v1);
  });

  it("does not notify for a deletion of an unknown id, or for ignored kinds", () => {
    const s = new MirrorStore();
    const cb = vi.fn();
    s.subscribe("tasks", cb);
    s.subscribe("lists", cb);
    s.applyPage([del("task", "nope"), { kind: "theme_image", id: "x", seq: 1, deleted: true }]);
    expect(cb).not.toHaveBeenCalled();
  });

  it("stores list groups and notifies lists subscribers", () => {
    const s = new MirrorStore();
    const cb = vi.fn();
    s.subscribe("lists", cb);
    s.applyPage([{ kind: "list_group", id: "g1", seq: 1, deleted: false, data: { name: "G", sort_key: null } }]);
    expect(s.groups().map((g) => g.id)).toEqual(["g1"]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("clear() empties the store and notifies", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1"), list("L1")]);
    const c1 = vi.fn(), cl = vi.fn();
    s.subscribe({ task: "t1" }, c1);
    s.subscribe("lists", cl);
    s.clear();
    expect(s.tasks()).toEqual([]);
    expect(s.lists()).toEqual([]);
    expect(s.task("t1")).toBeUndefined();
    expect(c1).toHaveBeenCalledTimes(1);
    expect(cl).toHaveBeenCalledTimes(1);
  });

  it("ignores every page after seal(), and clear() still works", () => {
    const s = new MirrorStore();
    expect(s.applyPage([task("t1"), list("l1")])).toBe(true);
    s.seal();
    const cb = vi.fn();
    s.subscribe("tasks", cb);
    expect(s.applyPage([task("t2")])).toBe(false);
    expect(s.task("t2")).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
    s.clear();
    expect(s.tasks()).toEqual([]);
    expect(s.lists()).toEqual([]);
    expect(s.applyPage([task("t3")])).toBe(false);
    expect(s.tasks()).toEqual([]);
  });
});

const TODAY = "2026-11-27";
const CTX = { today: TODAY, defaultListId: "L1" };
let mid = 0;
function mut(op: Op, sid: string, fields?: Record<string, unknown>): Mutation {
  mid += 1;
  return { id: `m${mid}`, at: "2026-11-27T12:00:00.000Z", op, sid, ...(fields ? { fields } : {}) };
}
// Subscribes to every key named and returns the keys notified, in key order.
function watch(s: MirrorStore, keys: (string | { task: string })[]): () => string[] {
  const hits = new Map<string, number>();
  for (const k of keys) {
    const name = typeof k === "string" ? k : `task:${k.task}`;
    s.subscribe(k as never, () => hits.set(name, (hits.get(name) ?? 0) + 1));
  }
  return () => [...hits.keys()].sort();
}

describe("MirrorStore pending edits", () => {
  const KEYS = ["tasks", "lists", { task: "t1" }, { task: "t2" }, { task: "n1" }];

  it("task() and tasks() show pending edits; baseTask() and baseTasks() the server state", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1", { title: "A" })]);
    s.setPending([mut("task.update", "t1", { title: "B" })], CTX);
    expect(s.task("t1")?.title).toBe("B");
    expect(s.tasks().map((t) => t.title)).toEqual(["B"]);
    expect(s.baseTask("t1")?.title).toBe("A");
    expect(s.baseTasks().map((t) => t.title)).toEqual(["A"]);
  });

  it("setPending notifies the edited task and tasks, nothing else", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1"), task("t2")]);
    const seen = watch(s, KEYS);
    s.setPending([mut("task.update", "t1", { title: "B" })], CTX);
    expect(seen()).toEqual(["task:t1", "tasks"]);
  });

  it("setPending notifies a pending create's key", () => {
    const s = new MirrorStore();
    const seen = watch(s, KEYS);
    s.setPending([mut("task.create", "n1", { title: "New" })], CTX);
    expect(seen()).toEqual(["task:n1", "tasks"]);
    expect(s.task("n1")?.list_id).toBe("L1");
  });

  it("setPending with an unchanged queue notifies nothing and keeps objects", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1"), task("t2")]);
    const m1 = mut("task.update", "t1", { title: "B" });
    s.setPending([m1], CTX);
    const t1 = s.task("t1"), all = s.tasks();
    const seen = watch(s, KEYS);
    s.setPending([m1], CTX);
    expect(seen()).toEqual([]);
    expect(s.task("t1")).toBe(t1);
    expect(s.tasks()).toBe(all);
  });

  it("adding an edit for one task leaves the other task's object and key alone", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1"), task("t2")]);
    const m1 = mut("task.update", "t1", { title: "B" });
    s.setPending([m1], CTX);
    const t1 = s.task("t1");
    const seen = watch(s, KEYS);
    s.setPending([m1, mut("task.update", "t2", { title: "C" })], CTX);
    expect(seen()).toEqual(["task:t2", "tasks"]);
    expect(s.task("t1")).toBe(t1);
  });

  it("a new today recomputes My Day edits", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1")]);
    const m = mut("myday.add", "t1");
    s.setPending([m], CTX);
    const seen = watch(s, KEYS);
    s.setPending([m], { ...CTX, today: "2026-11-28" });
    expect(s.task("t1")?.my_day.committed_day).toBe("2026-11-28");
    expect(seen()).toEqual(["task:t1", "tasks"]);
  });

  it("a pending myday.add shows in smartListTasks my_day", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1")]);
    s.setPending([mut("myday.add", "t1")], CTX);
    expect(smartListTasks(s, "my_day", { today: TODAY }).map((t) => t.id)).toEqual(["t1"]);
  });

  it("applyPage combines a base change with the edits still pending", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1", { title: "A", importance: "normal" }), task("t2")]);
    s.setPending([mut("task.update", "t1", { title: "Mine" })], CTX);
    const seen = watch(s, KEYS);
    s.applyPage([task("t1", { title: "A", importance: "high" })]);
    expect(s.task("t1")).toMatchObject({ title: "Mine", importance: "high" });
    expect(seen()).toEqual(["task:t1", "tasks"]);
  });

  it("applyPage deleting a task with a pending edit hides it", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1")]);
    s.setPending([mut("task.update", "t1", { title: "Mine" })], CTX);
    s.applyPage([del("task", "t1")]);
    expect(s.task("t1")).toBeUndefined();
    expect(s.tasks()).toEqual([]);
  });

  it("removing the last edit shows the base object again", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1")]);
    s.setPending([mut("task.update", "t1", { title: "Mine" })], CTX);
    const seen = watch(s, KEYS);
    s.setPending([], CTX);
    expect(s.task("t1")).toBe(s.baseTask("t1"));
    expect(seen()).toEqual(["task:t1", "tasks"]);
  });

  it("clear() drops the overlay and notifies pending-only tasks", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1")]);
    s.setPending([mut("task.create", "n1", { title: "New" }), mut("task.update", "t1", { title: "B" })], CTX);
    const seen = watch(s, KEYS);
    s.clear();
    expect(s.task("n1")).toBeUndefined();
    expect(s.tasks()).toEqual([]);
    expect(seen()).toEqual(["lists", "task:n1", "task:t1", "tasks"]);
  });

  it("seal() drops the overlay and ignores later pending edits", () => {
    const s = new MirrorStore();
    s.applyPage([task("t1", { title: "A" })]);
    s.setPending([mut("task.update", "t1", { title: "B" })], CTX);
    const seen = watch(s, KEYS);
    s.seal();
    expect(s.task("t1")?.title).toBe("A");
    expect(seen()).toEqual(["task:t1", "tasks"]);
    s.setPending([mut("task.create", "n1", { title: "New" })], CTX);
    expect(s.task("n1")).toBeUndefined();
  });
});
