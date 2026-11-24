// Cross-cutting sync invariants (Fable integration review of #32–#38), run on
// IndexCore in process:
//   - a create's sid is the app's from the first log row (reserveSid), and
//     the after-the-fact fallback (adoptSid) retires a minted sid a client
//     may already hold;
//   - a child mutation is skipped, not rejected for good, when its parent's
//     create failed earlier in the batch;
//   - server-side writes stamp field clocks, so an older queued app edit is
//     superseded (section 6), while the app's own write-through doesn't
//     supersede its next queued edit;
//   - a manual reorder is written to the mirror.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";
import type { FeedChange } from "../src/core/index/change-feed";
import { applyBatch, type ExecInput, type Executor } from "../src/core/sync/mutations";
import { storeOf } from "../test/_mutation-checks";
import type { OpsContext } from "../src/core/ops/context";
import { reorderTask } from "../src/core/ops/tasks";
import { reorderStep } from "../src/core/ops/steps";

const task = (id: string, title = id, modified = "2026-11-24T10:00:00Z", extra: Record<string, unknown> = {}) =>
  ({ id, title, status: "notStarted", lastModifiedDateTime: modified, ...extra }) as never;

function core() {
  const db = openDatabase(":memory:");
  const sql = sqlDb(db);
  const state = stateStore(db);
  const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  c.upsertList({ id: "L1", displayName: "One" } as never);
  return { c, sql };
}
function changesSince(c: IndexCore, cursor: string | null): { cursor: string; changes: FeedChange[] } {
  const r = c.syncChanges({ cursor });
  if (!r.ok) throw new Error(r.error);
  return r.page;
}
const listSidOf = (c: IndexCore) => changesSince(c, null).changes.find((x) => x.kind === "list")!.id;

const APP = "0190aaaa-0000-7000-8000-000000000001";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a create's sid", () => {
  it("is the app's from the first log row when reserved before the write-through", () => {
    const { c } = core();
    const base = changesSince(c, null).cursor;
    expect(c.reserveSid("task", APP, "G1")).toBe(true);
    c.upsertTask(task("G1", "new"), "L1");
    expect(changesSince(c, base).changes.map((x) => [x.id, x.deleted])).toEqual([[APP, false]]);
    expect(c.adoptSid("task", APP, "G1")).toBe(true);
  });

  it("retires a minted sid a client already pulled when adopted after the fact", () => {
    const { c } = core();
    const base = changesSince(c, null).cursor;
    c.upsertTask(task("G1", "new"), "L1");
    const pulled = changesSince(c, base);
    const minted = pulled.changes[0].id;
    expect(c.adoptSid("task", APP, "G1")).toBe(true);
    const after = changesSince(c, pulled.cursor).changes.map((x) => [x.id, x.deleted]);
    expect(after).toEqual([
      [minted, true],
      [APP, false],
    ]);
    expect(c.syncTask(minted)).toBeNull();
  });

  it("logs a step's task again when the step's minted sid is retired", () => {
    const { c } = core();
    c.upsertTask(task("G1"), "L1");
    c.upsertChecklistItem("G1", "L1", { id: "S1", displayName: "step" } as never);
    const pulled = changesSince(c, null);
    const taskSid = c.syncTaskSids(["G1"]).G1;
    expect(c.adoptSid("step", APP, "S1")).toBe(true);
    expect(changesSince(c, pulled.cursor).changes.map((x) => x.id)).toEqual([taskSid]);
  });
});

describe("a child of a parent whose create failed in the same batch", () => {
  it("is skipped, then applied when the batch is retried", async () => {
    const { c } = core();
    const listSid = listSidOf(c);
    const taskSid = "0190aaaa-0000-7000-8000-00000000000a";
    const stepSid = "0190aaaa-0000-7000-8000-00000000000b";
    let fail = true;
    const exec: Executor = async (i) => {
      if (i.op === "task.create") {
        if (fail) return { ok: false, error: "graph_503", retry: true };
        c.upsertTask(task("G9", "T"), "L1");
        return { ok: true, graphId: "G9" };
      }
      c.upsertChecklistItem(i.ids[taskSid], "L1", { id: "S9", displayName: "s" } as never);
      return { ok: true, graphId: "S9" };
    };
    const at = new Date().toISOString();
    const body = {
      mutations: [
        { id: "m1", at, op: "task.create", sid: taskSid, fields: { list_id: listSid, title: "T" } },
        { id: "m2", at, op: "step.create", sid: stepSid, fields: { task_id: taskSid, title: "s" } },
      ],
    };
    const r1 = await applyBatch(storeOf(c), exec, body, "p");
    expect(r1.results.map((r) => r.status)).toEqual(["failed", "skipped"]);
    fail = false;
    const r2 = await applyBatch(storeOf(c), exec, body, "p");
    expect(r2.results.map((r) => r.status)).toEqual(["applied", "applied"]);
  });
});

describe("field clocks", () => {
  const hour = 3_600_000;

  it("supersede an older queued app edit with a newer MCP (or To Do) edit", async () => {
    const { c } = core();
    const t0 = Date.now() - 2 * hour;
    c.upsertTask(task("G1", "original", new Date(t0).toISOString()), "L1");
    const sid = c.syncTaskSids(["G1"]).G1;
    // 09:00 offline app edit; 09:30 MCP edit (its write-through); the app sends at 09:00.
    const appEditAt = new Date(t0 + hour).toISOString();
    c.upsertTask(task("G1", "MCP title", new Date(t0 + 1.5 * hour).toISOString()), "L1");
    const sent: ExecInput[] = [];
    const exec: Executor = async (i) => (sent.push(i), { ok: true, graphId: "G1" });
    const r = await applyBatch(storeOf(c), exec, { mutations: [{ id: "m1", at: appEditAt, op: "task.update", sid, fields: { title: "app title" } }] }, "p");
    expect(r.results[0]).toEqual({ id: "m1", status: "applied", sid, superseded_fields: ["title"] });
    expect(sent).toEqual([]);
  });

  it("don't let the app's own write-through supersede its next queued edit", async () => {
    const { c } = core();
    c.upsertTask(task("G1", "original", new Date(Date.now() - 3 * hour).toISOString()), "L1");
    const sid = c.syncTaskSids(["G1"]).G1;
    // Graph stamps its write now, later than both queued edits; the first
    // edit (a completion) also changes status as a consequence.
    const exec: Executor = async (i) => {
      const f = i.fields as Record<string, string>;
      const completed = f.completed_at ? { status: "completed", completedDateTime: { dateTime: f.completed_at, timeZone: "UTC" } } : {};
      c.upsertTask(task("G1", f.title ?? "original", new Date().toISOString(), { ...completed, ...(f.status ? { status: f.status } : {}) }), "L1");
      return { ok: true, graphId: "G1" };
    };
    const at1 = new Date(Date.now() - 2 * hour).toISOString();
    const at2 = new Date(Date.now() - hour).toISOString();
    const r = await applyBatch(storeOf(c), exec, {
      mutations: [
        { id: "m1", at: at1, op: "task.update", sid, fields: { completed_at: "2026-11-20" } },
        { id: "m2", at: at2, op: "task.update", sid, fields: { status: "notStarted" } },
      ],
    }, "p");
    expect(r.results).toEqual([
      { id: "m1", status: "applied", sid },
      { id: "m2", status: "applied", sid },
    ]);
    expect(c.fieldClocks("task", sid).status).toBe(Date.parse(at2));
  });

  it("are stamped for a list, step and link edited server-side, and not on insert", () => {
    const { c, sql } = core();
    c.upsertTask(task("G1"), "L1");
    c.upsertChecklistItem("G1", "L1", { id: "S1", displayName: "a", isChecked: false } as never);
    c.upsertLinkedResource("G1", "L1", { id: "K1", webUrl: "https://a.example", displayName: "a" } as never);
    const sidOf = (kind: string, graphId: string) =>
      sql.exec<{ sid: string }>("SELECT sid FROM entity_map WHERE kind = ? AND graph_id = ?", kind, graphId).one().sid;
    const clocks = () => ({
      list: c.fieldClocks("list", sidOf("list", "L1")),
      step: c.fieldClocks("step", sidOf("step", "S1")),
      link: c.fieldClocks("link", sidOf("link", "K1")),
    });
    expect(clocks()).toEqual({ list: {}, step: {}, link: {} });
    c.upsertList({ id: "L1", displayName: "Renamed" } as never);
    c.upsertChecklistItem("G1", "L1", { id: "S1", displayName: "a", isChecked: true } as never);
    c.upsertLinkedResource("G1", "L1", { id: "K1", webUrl: "https://b.example", displayName: "a" } as never);
    const after = clocks();
    expect([Object.keys(after.list), Object.keys(after.step), Object.keys(after.link)]).toEqual([["name"], ["checked"], ["url"]]);
  });
});

describe("field clocks of fields a mutation didn't name", () => {
  const hour = 3_600_000;
  // Graph's copy of G1: a PATCH merges into it and answers with all of it.
  function graph(c: IndexCore, start: Record<string, unknown>) {
    let cur = { ...start };
    const exec: Executor = async (i) => {
      cur = { ...cur, ...i.fields };
      c.upsertTask(task("G1", cur.title as string, new Date().toISOString(), cur), "L1");
      return { ok: true, graphId: "G1" };
    };
    return { exec, cur: () => cur };
  }
  const update = (id: string, at: number, sid: string, fields: Record<string, unknown>) => ({
    id,
    at: new Date(at).toISOString(),
    op: "task.update",
    sid,
    fields,
  });

  it("keep a newer server-side edit made just before the batch", async () => {
    const { c } = core();
    const now = Date.now();
    c.upsertTask(task("G1", "original", new Date(now - 5 * hour).toISOString()), "L1");
    const sid = c.syncTaskSids(["G1"]).G1;
    c.upsertTask(task("G1", "MCP title", new Date(now - 2000).toISOString()), "L1");
    const g = graph(c, { title: "MCP title", importance: "normal" });
    const r = await applyBatch(storeOf(c), g.exec, {
      mutations: [update("m1", now - 2 * hour, sid, { importance: "high" }), update("m2", now - hour, sid, { title: "stale" })],
    }, "p");
    expect(r.results[1]).toEqual({ id: "m2", status: "applied", sid, superseded_fields: ["title"] });
    expect(g.cur().title).toBe("MCP title");
  });

  it("keep a To Do edit first seen in the app's own PATCH response", async () => {
    const { c } = core();
    const now = Date.now();
    c.upsertTask(task("G1", "original", new Date(now - 5 * hour).toISOString()), "L1");
    const sid = c.syncTaskSids(["G1"]).G1;
    // To Do renamed it; delta hasn't delivered that yet, Graph has it.
    const g = graph(c, { title: "To Do title", importance: "normal" });
    await applyBatch(storeOf(c), g.exec, { mutations: [update("m1", now - 2 * hour, sid, { importance: "high" })] }, "p");
    const r = await applyBatch(storeOf(c), g.exec, { mutations: [update("m2", now - hour, sid, { title: "stale" })] }, "p");
    expect(r.results[0]).toEqual({ id: "m2", status: "applied", sid, superseded_fields: ["title"] });
  });

  it("keep a delta edit made after a retried mutation's first attempt", async () => {
    const { c } = core();
    const now = Date.now();
    c.upsertTask(task("G1", "original", new Date(now - 5 * hour).toISOString()), "L1");
    const sid = c.syncTaskSids(["G1"]).G1;
    c.mutationBegin("m1", "p", now - hour, 60_000); // first attempt died an hour ago
    c.upsertTask(task("G1", "To Do title", new Date(now - hour / 2).toISOString()), "L1");
    const g = graph(c, { title: "To Do title", importance: "normal" });
    const r = await applyBatch(storeOf(c), g.exec, {
      mutations: [update("m1", now - 2 * hour, sid, { importance: "high" }), update("m2", now - 1.5 * hour, sid, { title: "stale" })],
    }, "p");
    expect(r.results[1]).toEqual({ id: "m2", status: "applied", sid, superseded_fields: ["title"] });
  });

  it("stamp a step's checked with Graph's checkedDateTime", () => {
    const { c, sql } = core();
    c.upsertTask(task("G1"), "L1");
    c.upsertChecklistItem("G1", "L1", { id: "S1", displayName: "a", isChecked: false } as never);
    c.upsertChecklistItem("G1", "L1", { id: "S1", displayName: "a", isChecked: true, checkedDateTime: "2026-11-20T10:39:03.7937971Z" } as never);
    const sid = sql.exec<{ sid: string }>("SELECT sid FROM entity_map WHERE kind = 'step' AND graph_id = 'S1'").one().sid;
    expect(c.fieldClocks("step", sid)).toEqual({ checked: Date.parse("2026-11-20T10:39:03.793Z") });
  });
});

describe("batch skipping", () => {
  it("doesn't skip creates under a parent whose edit failed", async () => {
    const { c } = core();
    const listSid = listSidOf(c);
    const exec: Executor = async (i) => {
      if (i.op === "list.update") return { ok: false, error: "graph_403", retry: false };
      c.upsertTask(task("G5"), "L1");
      return { ok: true, graphId: "G5" };
    };
    const at = new Date().toISOString();
    const r = await applyBatch(storeOf(c), exec, {
      mutations: [
        { id: "m1", at, op: "list.update", sid: listSid, fields: { name: "x" } },
        { id: "m2", at, op: "task.create", sid: APP, fields: { list_id: listSid, title: "t" } },
      ],
    }, "p");
    expect(r.results.map((x) => x.status)).toEqual(["failed", "applied"]);
  });

  it("refuses an `at` without a zone", async () => {
    const { c } = core();
    const r = await applyBatch(storeOf(c), async () => ({ ok: true, graphId: "x" }), {
      mutations: [{ id: "m1", at: "2026-11-24T10:00:00", op: "list.create", sid: APP, fields: { name: "x" } }],
    }, "p");
    expect(r.results).toEqual([{ id: "m1", status: "rejected", error: "bad_at" }]);
  });

  it("applies a retried create whose sid was reserved but never mirrored", async () => {
    const { c } = core();
    const listSid = listSidOf(c);
    c.mutationBegin("m1", "p", Date.now() - 120_000, 60_000); // the attempt that crashed
    c.reserveSid("task", APP, "G7"); // after Graph's create, before the mirror write
    const exec = vi.fn<Executor>();
    const r = await applyBatch(storeOf(c), exec, {
      mutations: [{ id: "m1", at: new Date().toISOString(), op: "task.create", sid: APP, fields: { list_id: listSid, title: "t" } }],
    }, "p");
    expect(r.results).toEqual([{ id: "m1", status: "applied", sid: APP }]);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("a manual reorder", () => {
  function ctxFor(c: IndexCore, sub: Record<string, unknown>): OpsContext {
    return {
      env: { TIMEZONE: "UTC" },
      graph: { translateToImmutable: async (ids: string[]) => new Map(ids.map((i) => [i, i])) },
      index: c,
      substrate: async () => sub,
      accessToken: async () => "t",
      writes: { run: (fn: () => Promise<unknown>) => fn() },
    } as unknown as OpsContext;
  }

  it("of a task is written to the mirror, so it's logged and pushed", async () => {
    const { c, sql } = core();
    c.upsertTask(task("G1"), "L1");
    c.upsertTask(task("G2"), "L1");
    const base = changesSince(c, null).cursor;
    const r = await reorderTask(
      ctxFor(c, { listFolderTasks: async () => [{ Id: "G2", OrderDateTime: "2026-11-20T00:00:00Z" }], patchTask: async () => ({}) }),
      { list_id: "L1", task_id: "G1", position: { kind: "top" } },
    );
    expect(r.ok).toBe(true);
    const row = sql.exec<{ order_datetime: string }>("SELECT order_datetime FROM tasks WHERE task_id = 'G1'").one();
    expect(row.order_datetime).toBe(r.ok ? r.value.order_datetime : null);
    expect(changesSince(c, base).changes.map((x) => x.id)).toEqual([c.syncTaskSids(["G1"]).G1]);
  });

  it("of a step is written to the mirror", async () => {
    const { c, sql } = core();
    c.upsertTask(task("G1"), "L1");
    c.upsertChecklistItem("G1", "L1", { id: "S1", displayName: "a" } as never);
    c.upsertChecklistItem("G1", "L1", { id: "S2", displayName: "b" } as never);
    const r = await reorderStep(
      ctxFor(c, {
        listSubtasks: async () => [
          { Id: "S1", OrderDateTime: null },
          { Id: "S2", OrderDateTime: "2026-11-20T00:00:00Z" },
        ],
        patchSubtask: async () => ({}),
      }),
      { list_id: "L1", task_id: "G1", item_id: "S1", position: { kind: "top" } },
    );
    expect(r.ok).toBe(true);
    const row = sql.exec<{ order_datetime: string }>("SELECT order_datetime FROM checklist_items WHERE item_id = 'S1'").one();
    expect(row.order_datetime).toBe(r.ok ? r.value.order_datetime : null);
  });
});
