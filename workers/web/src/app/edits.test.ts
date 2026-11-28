import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedChange, FeedList, FeedTask } from "../sync/feed.ts";
import type { Mutation } from "../sync/mutation.ts";
import type { Outbox } from "../sync/outbox.ts";
import { MirrorStore } from "../sync/store.ts";
import { createEdits, defaultListId } from "./edits.ts";
import { todayIn } from "./loader.ts";
import type { Route } from "./route.ts";

// 04:30 UTC on Nov 27 is still Nov 26 in New York: "today" must be the
// owner's date (the server's zone), not the device's or UTC's.
const NOW = new Date("2026-11-27T04:30:00Z");
const ZONE = "America/New_York";
const OWNER_TODAY = "2026-11-26";
const loader = { today: (now = new Date()) => todayIn(ZONE, now) };

function taskData(over: Partial<FeedTask> = {}): FeedTask {
  return {
    list_id: "L1", title: "T", status: "notStarted", body: null, importance: "normal", categories: [],
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

/** Records what is enqueued; nothing is sent. */
function fakeOutbox() {
  const sent: Array<Omit<Mutation, "id" | "at">> = [];
  const outbox: Pick<Outbox, "enqueue"> = {
    enqueue(m) {
      sent.push(m);
      return { ...m, id: `m${sent.length}`, at: NOW.toISOString() };
    },
  };
  return { outbox, sent };
}

function setup(...extra: FeedChange[]) {
  const store = new MirrorStore();
  store.applyPage([
    list("L1", { name: "Errands" }),
    list("DEF", { name: "Tasks", wellknown: "defaultList" }),
    task("t1"),
    task("t-text", { body: { type: "text", content: "old" } }),
    task("t-html", { body: { type: "html", content: "<p>flagged</p>" } }),
    task("t-step", { steps: [{ id: "s1", title: "Step", checked: false, checked_at: null, created_at: null, order: null }] }),
    ...extra,
  ]);
  const { outbox, sent } = fakeOutbox();
  let n = 0;
  const edits = createEdits(outbox, store, loader, () => `new-${++n}`);
  return { store, sent, edits };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("defaultListId", () => {
  it("is the list whose wellknown is defaultList", () => {
    expect(defaultListId(setup().store)).toBe("DEF");
  });
  it("is null before the lists load", () => {
    expect(defaultListId(new MirrorStore())).toBeNull();
  });
});

describe("addTask", () => {
  const smart = (l: "my_day" | "important" | "planned" | "all" | "completed"): Route => ({ view: "smart", list: l });

  it("in a regular list, creates the task in that list", () => {
    const { edits, sent } = setup();
    expect(edits.addTask("Buy milk", { view: "list", id: "L1" })).toBe("new-1");
    expect(sent).toEqual([{ op: "task.create", sid: "new-1", fields: { list_id: "L1", title: "Buy milk" } }]);
  });

  it("in Important, creates it in the default list with importance high", () => {
    const { edits, sent } = setup();
    edits.addTask("Call", smart("important"));
    expect(sent).toEqual([
      { op: "task.create", sid: "new-1", fields: { list_id: "DEF", title: "Call", importance: "high" } },
    ]);
  });

  it("in Planned, creates it due today in the owner's zone", () => {
    const { edits, sent } = setup();
    edits.addTask("Call", smart("planned"));
    expect(sent).toEqual([
      { op: "task.create", sid: "new-1", fields: { list_id: "DEF", title: "Call", due: OWNER_TODAY } },
    ]);
  });

  it("in My Day, creates it and then adds the same sid to My Day", () => {
    const { edits, sent } = setup();
    edits.addTask("Call", smart("my_day"));
    expect(sent).toEqual([
      { op: "task.create", sid: "new-1", fields: { list_id: "DEF", title: "Call" } },
      { op: "myday.add", sid: "new-1" },
    ]);
  });

  it.each(["all", "completed"] as const)("in %s, creates it in the default list with nothing extra", (l) => {
    const { edits, sent } = setup();
    edits.addTask("Call", smart(l));
    expect(sent).toEqual([{ op: "task.create", sid: "new-1", fields: { list_id: "DEF", title: "Call" } }]);
  });

  it("from search, creates it in the default list", () => {
    const { edits, sent } = setup();
    edits.addTask("Call", { view: "search", q: "x", all: false, includeCompleted: true });
    expect(sent).toEqual([{ op: "task.create", sid: "new-1", fields: { list_id: "DEF", title: "Call" } }]);
  });

  it("trims the title", () => {
    const { edits, sent } = setup();
    edits.addTask("  Call  ", { view: "list", id: "L1" });
    expect(sent[0]!.fields).toEqual({ list_id: "L1", title: "Call" });
  });

  it("ignores a blank title", () => {
    const { edits, sent } = setup();
    expect(edits.addTask("   ", smart("my_day"))).toBeNull();
    expect(edits.addTask("", { view: "list", id: "L1" })).toBeNull();
    expect(sent).toEqual([]);
  });

  it("throws, sending nothing, when a smart list needs the default list and there is none", () => {
    const store = new MirrorStore();
    const { outbox, sent } = fakeOutbox();
    const edits = createEdits(outbox, store, loader, () => "x");
    expect(() => edits.addTask("Call", smart("all"))).toThrow(/default list/);
    expect(sent).toEqual([]);
  });

  it("gives each new task its own sid", () => {
    const { edits, sent } = setup();
    edits.addTask("A", { view: "list", id: "L1" });
    edits.addTask("B", { view: "list", id: "L1" });
    expect(sent.map((m) => m.sid)).toEqual(["new-1", "new-2"]);
  });
});

describe("task edits", () => {
  it("setCompleted sends status completed without completed_at, and notStarted to undo", () => {
    const { edits, sent } = setup();
    edits.setCompleted("t1", true);
    edits.setCompleted("t1", false);
    expect(sent).toEqual([
      { op: "task.update", sid: "t1", fields: { status: "completed" } },
      { op: "task.update", sid: "t1", fields: { status: "notStarted" } },
    ]);
  });

  it("setImportant sends importance high or normal", () => {
    const { edits, sent } = setup();
    edits.setImportant("t1", true);
    edits.setImportant("t1", false);
    expect(sent).toEqual([
      { op: "task.update", sid: "t1", fields: { importance: "high" } },
      { op: "task.update", sid: "t1", fields: { importance: "normal" } },
    ]);
  });

  it("rename sends the trimmed title", () => {
    const { edits, sent } = setup();
    edits.rename("t1", " New name ");
    expect(sent).toEqual([{ op: "task.update", sid: "t1", fields: { title: "New name" } }]);
  });

  it("rename with a blank title does nothing", () => {
    const { edits, sent } = setup();
    edits.rename("t1", "  ");
    expect(sent).toEqual([]);
  });

  it("setNotes sends a text body, on a text body or an empty one", () => {
    const { edits, sent } = setup();
    edits.setNotes("t-text", "new note");
    edits.setNotes("t1", "first note");
    expect(sent).toEqual([
      { op: "task.update", sid: "t-text", fields: { body: { type: "text", content: "new note" } } },
      { op: "task.update", sid: "t1", fields: { body: { type: "text", content: "first note" } } },
    ]);
  });

  it("setNotes on an HTML body throws, and nothing is enqueued", () => {
    const { edits, sent } = setup();
    expect(() => edits.setNotes("t-html", "flattened")).toThrow(/html/i);
    expect(sent).toEqual([]);
  });

  it("setNotes throws for a body of a type it doesn't know, and for an unknown task", () => {
    const { edits, sent } = setup(task("t-rtf", { body: { type: "rtf", content: "x" } }));
    expect(() => edits.setNotes("t-rtf", "x")).toThrow();
    expect(() => edits.setNotes("missing", "x")).toThrow();
    expect(sent).toEqual([]);
  });

  it("setDue sends a bare date, or null to clear", () => {
    const { edits, sent } = setup();
    edits.setDue("t1", "2026-12-01");
    edits.setDue("t1", null);
    expect(sent).toEqual([
      { op: "task.update", sid: "t1", fields: { due: "2026-12-01" } },
      { op: "task.update", sid: "t1", fields: { due: null } },
    ]);
  });

  it("setReminder sends the feed's reminder shape: on with an instant, or off with none", () => {
    const { edits, sent } = setup();
    edits.setReminder("t1", "2026-11-27T14:00:00.000Z");
    edits.setReminder("t1", null);
    expect(sent).toEqual([
      { op: "task.update", sid: "t1", fields: { reminder: { on: true, at: "2026-11-27T14:00:00.000Z" } } },
      { op: "task.update", sid: "t1", fields: { reminder: { on: false, at: null } } },
    ]);
  });

  it("setMyDay sends myday.add or myday.remove, with no fields", () => {
    const { edits, sent } = setup();
    edits.setMyDay("t1", true);
    edits.setMyDay("t1", false);
    expect(sent).toEqual([
      { op: "myday.add", sid: "t1" },
      { op: "myday.remove", sid: "t1" },
    ]);
  });

  it("move sends task.move with the list id", () => {
    const { edits, sent } = setup();
    edits.move("t1", "DEF");
    expect(sent).toEqual([{ op: "task.move", sid: "t1", fields: { list_id: "DEF" } }]);
  });

  it("remove sends task.delete", () => {
    const { edits, sent } = setup();
    edits.remove("t1");
    expect(sent).toEqual([{ op: "task.delete", sid: "t1" }]);
  });
});

describe("step edits", () => {
  it("addStep creates an unchecked step on the task with a new sid", () => {
    const { edits, sent } = setup();
    expect(edits.addStep("t-step", " Pack ")).toBe("new-1");
    expect(sent).toEqual([
      { op: "step.create", sid: "new-1", fields: { task_id: "t-step", title: "Pack", checked: false } },
    ]);
  });

  it("addStep with a blank title does nothing", () => {
    const { edits, sent } = setup();
    expect(edits.addStep("t-step", " ")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("setStepChecked sends checked", () => {
    const { edits, sent } = setup();
    edits.setStepChecked("s1", true);
    edits.setStepChecked("s1", false);
    expect(sent).toEqual([
      { op: "step.update", sid: "s1", fields: { checked: true } },
      { op: "step.update", sid: "s1", fields: { checked: false } },
    ]);
  });

  it("renameStep sends the trimmed title; a blank one does nothing", () => {
    const { edits, sent } = setup();
    edits.renameStep("s1", " Unpack ");
    edits.renameStep("s1", "");
    expect(sent).toEqual([{ op: "step.update", sid: "s1", fields: { title: "Unpack" } }]);
  });

  it("removeStep sends step.delete", () => {
    const { edits, sent } = setup();
    edits.removeStep("s1");
    expect(sent).toEqual([{ op: "step.delete", sid: "s1" }]);
  });
});
