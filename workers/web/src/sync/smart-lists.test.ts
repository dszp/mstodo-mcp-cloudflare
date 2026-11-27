import { describe, expect, it } from "vitest";
import type { FeedChange, FeedList, FeedTask } from "./feed";
import { listTasks, searchLocal, smartCounts, smartListTasks } from "./smart-lists";
import { MirrorStore } from "./store";

const TODAY = "2026-11-27";

function taskData(over: Partial<FeedTask> = {}): FeedTask {
  return {
    list_id: "L1", title: "T", status: "notStarted", body: null, importance: null, categories: [],
    due: null, start: null, reminder: { on: false, at: null }, completed_at: null, recurrence: null,
    created_at: null, modified_at: null, order: null,
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
let seq = 0;
const task = (id: string, over: Partial<FeedTask> = {}): FeedChange => ({
  kind: "task", id, seq: ++seq, deleted: false, data: taskData(over), field_clock: {},
});
const list = (id: string, over: Partial<FeedList> = {}): FeedChange => ({
  kind: "list", id, seq: ++seq, deleted: false, data: listData(over),
});
const myDay = (day: string | null, order: string | null = null) => ({
  committed_day: day, committed_order: order, postponed_day: null,
});
function store(...changes: FeedChange[]): MirrorStore {
  const s = new MirrorStore();
  s.applyPage([list("L1"), list("REF", { sync: "reference" }), ...changes]);
  return s;
}
const ids = (ts: readonly { id: string }[]) => ts.map((t) => t.id);
const opts = { today: TODAY };

describe("smartListTasks", () => {
  it("my_day orders by committed_order desc, then order desc", () => {
    const s = store(
      task("a", { my_day: myDay(TODAY, "1"), order: "9" }),
      task("b", { my_day: myDay(TODAY, "2"), order: "1" }),
      task("c", { my_day: myDay(TODAY, "1"), order: "5" }),
      task("x", { my_day: myDay("2026-11-26", "9") }),
    );
    expect(ids(smartListTasks(s, "my_day", opts))).toEqual(["b", "a", "c"]);
  });

  it("my_day holds completed tasks too", () => {
    const s = store(task("a", { status: "completed", completed_at: TODAY, my_day: myDay(TODAY) }));
    expect(ids(smartListTasks(s, "my_day", opts))).toEqual(["a"]);
  });

  it("my_day with dueTodayInMyDay adds open tasks due today", () => {
    const s = store(
      task("a", { my_day: myDay(TODAY, "1") }),
      task("d", { due: TODAY }),
      task("done", { due: TODAY, status: "completed", completed_at: TODAY }),
      task("later", { due: "2026-11-28" }),
    );
    expect(ids(smartListTasks(s, "my_day", opts))).toEqual(["a"]);
    expect(ids(smartListTasks(s, "my_day", { ...opts, dueTodayInMyDay: true }))).toEqual(["a", "d"]);
  });

  it("important holds open high-importance tasks only", () => {
    const s = store(
      task("hi", { importance: "high", order: "2", created_at: "2026-01-01" }),
      task("hi2", { importance: "high", order: "2", created_at: "2026-02-01" }),
      task("lo", { importance: "low" }),
      task("done", { importance: "high", status: "completed", completed_at: TODAY }),
    );
    expect(ids(smartListTasks(s, "important", opts))).toEqual(["hi2", "hi"]);
  });

  it("planned ignores tasks with only a reminder", () => {
    const s = store(
      task("rem", { reminder: { on: true, at: "2026-11-30T09:00:00" } }),
      task("due", { due: "2026-12-01" }),
    );
    expect(ids(smartListTasks(s, "planned", opts))).toEqual(["due"]);
  });

  it("planned sorts by due ascending", () => {
    const s = store(
      task("c", { due: "2026-12-03" }), task("a", { due: "2026-12-01", order: "1" }),
      task("b", { due: "2026-12-01", order: "2" }),
    );
    expect(ids(smartListTasks(s, "planned", opts))).toEqual(["b", "a", "c"]);
  });

  it("all holds open tasks, order desc then created_at desc", () => {
    const s = store(
      task("a", { order: "1" }), task("b", { order: "2" }),
      task("c", { order: "1", created_at: "2026-05-01" }),
      task("done", { status: "completed", completed_at: TODAY }),
    );
    expect(ids(smartListTasks(s, "all", opts))).toEqual(["b", "c", "a"]);
  });

  it("completed orders by completed_at desc, then modified_at desc", () => {
    const done = { status: "completed" };
    const s = store(
      task("a", { ...done, completed_at: "2026-11-01", modified_at: "1" }),
      task("b", { ...done, completed_at: "2026-11-02", modified_at: "1" }),
      task("c", { ...done, completed_at: "2026-11-01", modified_at: "2" }),
      task("open"),
    );
    expect(ids(smartListTasks(s, "completed", opts))).toEqual(["b", "c", "a"]);
  });

  it("completed honours completedSince", () => {
    const done = { status: "completed" };
    const s = store(
      task("old", { ...done, completed_at: "2026-10-01" }),
      task("new", { ...done, completed_at: "2026-11-20" }),
      task("undated", done),
    );
    expect(ids(smartListTasks(s, "completed", opts))).toEqual(["new", "old", "undated"]);
    expect(ids(smartListTasks(s, "completed", { ...opts, completedSince: "2026-11-01" }))).toEqual(["new"]);
  });

  it("smart lists leave out reference lists", () => {
    const s = store(
      task("ref", { list_id: "REF", importance: "high", due: TODAY, my_day: myDay(TODAY) }),
      task("ok", { importance: "high" }),
    );
    expect(ids(smartListTasks(s, "important", opts))).toEqual(["ok"]);
    expect(ids(smartListTasks(s, "my_day", { ...opts, dueTodayInMyDay: true }))).toEqual([]);
    expect(smartCounts(s, opts).important).toBe(1);
    expect(smartCounts(s, opts).all).toBe(1);
  });

  it("includes a task whose list has not arrived", () => {
    const s = store(task("orphan", { list_id: "NOPE" }));
    expect(ids(smartListTasks(s, "all", opts))).toEqual(["orphan"]);
  });

  it("nulls sort last descending and first ascending", () => {
    const s = store(
      task("n", { order: null, due: null }),
      task("o", { order: "1" }),
    );
    expect(ids(smartListTasks(s, "all", opts))).toEqual(["o", "n"]);
    const p = store(task("d", { due: "2026-12-01" }), task("e", { due: "2026-12-02" }));
    expect(ids(smartListTasks(p, "planned", opts))).toEqual(["d", "e"]);
    // asc: a null due would sort first; completed_at null sorts last in a desc sort.
    const c = store(task("nd", { status: "completed" }), task("d", { status: "completed", completed_at: "2026-11-01" }));
    expect(ids(smartListTasks(c, "completed", opts))).toEqual(["d", "nd"]);
  });

  it("breaks ties by id ascending", () => {
    const s = store(task("b"), task("a"), task("c"));
    expect(ids(smartListTasks(s, "all", opts))).toEqual(["a", "b", "c"]);
  });

  it("counts open tasks, and completed tasks for completed", () => {
    const s = store(
      task("a"), task("b", { importance: "high", due: "2026-12-01" }),
      task("c", { status: "completed", completed_at: "2026-11-01", my_day: myDay(TODAY) }),
      task("d", { my_day: myDay(TODAY) }),
    );
    expect(smartCounts(s, opts)).toEqual({ my_day: 1, important: 1, planned: 1, all: 3, completed: 1 });
  });
});

describe("listTasks", () => {
  it("lists open by order desc then completed by completed_at desc", () => {
    const s = store(
      task("o1", { order: "1" }), task("o2", { order: "2" }), task("onull"),
      task("c1", { status: "completed", completed_at: "2026-11-01" }),
      task("c2", { status: "completed", completed_at: "2026-11-02" }),
      task("other", { list_id: "L2" }),
    );
    expect(ids(listTasks(s, "L1"))).toEqual(["o2", "o1", "onull", "c2", "c1"]);
  });
});

describe("searchLocal", () => {
  it("search includes reference lists", () => {
    const s = store(task("ref", { list_id: "REF", importance: "high", title: "Quarterly report" }));
    expect(ids(searchLocal(s, "report"))).toEqual(["ref"]);
    expect(ids(smartListTasks(s, "important", opts))).toEqual([]);
  });

  it("search needs every word, in title, body or a step", () => {
    const step = { id: "s", title: "Call Acme", checked: false, checked_at: null, created_at: null, order: null };
    const s = store(
      task("t", { title: "Renew contract" }),
      task("b", { title: "Misc", body: { type: "text", content: "contract with Acme" } }),
      task("st", { title: "Misc2", steps: [step] }),
      task("none", { title: "Renew" }),
    );
    expect(ids(searchLocal(s, "renew contract"))).toEqual(["t"]);
    expect(ids(searchLocal(s, "acme contract"))).toEqual(["b"]);
    expect(ids(searchLocal(s, "misc2 CALL"))).toEqual(["st"]);
    expect(ids(searchLocal(s, "   "))).toEqual([]);
  });

  it("folds case for ASCII letters only", () => {
    const s = store(task("a", { title: "Straße" }), task("b", { title: "ÉCOLE" }));
    expect(ids(searchLocal(s, "STRAßE"))).toEqual(["a"]);
    expect(ids(searchLocal(s, "école"))).toEqual([]);
    expect(ids(searchLocal(s, "École"))).toEqual(["b"]);
  });

  it("search ranks open before completed, title matches before body", () => {
    const done = { status: "completed", completed_at: "2026-11-01" };
    const s = store(
      task("openBody", { title: "x", body: { type: "text", content: "plan here" }, order: "9" }),
      task("openTitle", { title: "Plan it", order: "1" }),
      task("doneBody", { ...done, title: "y", body: { type: "text", content: "plan" }, order: "9" }),
      task("doneTitle", { ...done, title: "plan", order: "1" }),
    );
    expect(ids(searchLocal(s, "plan"))).toEqual(["openTitle", "openBody", "doneTitle", "doneBody"]);
  });

  it("tests only the first word against the title, folding case the same way", () => {
    const s = store(
      task("a", { title: "Alpha", body: { type: "text", content: "beta" } }),
      task("b", { title: "beta", body: { type: "text", content: "ALPHA" } }),
    );
    expect(ids(searchLocal(s, "ALPHA beta"))).toEqual(["a", "b"]);
    expect(ids(searchLocal(s, "beta alpha"))).toEqual(["b", "a"]);
  });

  it("orders within a group by order desc (nulls last), then id asc", () => {
    const s = store(task("z", { title: "w", order: "2" }), task("b", { title: "w" }), task("a", { title: "w" }));
    expect(ids(searchLocal(s, "w"))).toEqual(["z", "a", "b"]);
  });

  it("honours includeCompleted and completedSince", () => {
    const s = store(
      task("open", { title: "q" }),
      task("old", { title: "q", status: "completed", completed_at: "2026-10-01" }),
      task("new", { title: "q", status: "completed", completed_at: "2026-11-20" }),
      task("undated", { title: "q", status: "completed" }),
    );
    expect(ids(searchLocal(s, "q"))).toEqual(["open", "new", "old", "undated"]);
    expect(ids(searchLocal(s, "q", { includeCompleted: false }))).toEqual(["open"]);
    expect(ids(searchLocal(s, "q", { completedSince: "2026-11-01" }))).toEqual(["open", "new"]);
  });

  it("scopes to one list, reference lists included", () => {
    const s = store(task("a", { title: "q" }), task("r", { title: "q", list_id: "REF" }));
    expect(ids(searchLocal(s, "q", { scope: { listId: "REF" } }))).toEqual(["r"]);
  });

  it("smart-list scope applies the Holds rule without the open requirement", () => {
    const s = store(
      task("hi", { title: "q", importance: "high" }),
      task("hiDone", { title: "q", importance: "high", status: "completed", completed_at: TODAY }),
      task("lo", { title: "q" }),
      task("hiRef", { title: "q", importance: "high", list_id: "REF" }),
    );
    const scope = { smart: "important" as const, today: TODAY };
    expect(ids(searchLocal(s, "q", { scope }))).toEqual(["hi", "hiDone"]);
    expect(ids(searchLocal(s, "q", { scope, includeCompleted: false }))).toEqual(["hi"]);
  });

  it("my_day scope: committed tasks of any status, due-today branch stays open-only", () => {
    const s = store(
      task("c", { title: "q", status: "completed", completed_at: TODAY, my_day: myDay(TODAY) }),
      task("dueOpen", { title: "q", due: TODAY }),
      task("dueDone", { title: "q", due: TODAY, status: "completed", completed_at: TODAY }),
      task("dueRef", { title: "q", due: TODAY, list_id: "REF" }),
    );
    const base = { smart: "my_day" as const, today: TODAY };
    expect(ids(searchLocal(s, "q", { scope: base }))).toEqual(["c"]);
    expect(ids(searchLocal(s, "q", { scope: { ...base, dueTodayInMyDay: true } }))).toEqual(["dueOpen", "c"]);
  });
});
