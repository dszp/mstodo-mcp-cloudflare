// Characterization tests for the MCP write tools, end to end through a real
// McpServer + Client (in-memory transport), the in-process IndexCore, and a
// scripted fetch. Written against the pre-extraction tool handlers so the
// snapshots pin today's output format and Graph/Substrate call sequence; the
// src/core/ops extraction must leave every snapshot unchanged.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { buildNodeEnv } from "../src/hosts/node/env";
import { SCOPES, storeTokens } from "../src/core/auth/microsoft";
import { createMcpServer } from "../src/core/mcp/server";
import { registerTools } from "../src/core/mcp/register-tools";

const G = "https://graph.microsoft.com/v1.0/me/todo/lists";
const S = "https://substrate.office.com/todob2/api/v1";
const NOW = Date.parse("2026-11-24T15:00:00.000Z");

type Call = { method: string; url: string; body?: unknown; ifMatch?: string };
type Route = (method: string, url: string, body: unknown) => Response | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const notFound = () => json({ error: { code: "ErrorItemNotFound", message: "not found" } }, 404);
const noContent = () => new Response(null, { status: 204 });

function task(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `title ${id}`,
    status: "notStarted",
    importance: "normal",
    createdDateTime: "2026-11-20T10:00:00Z",
    lastModifiedDateTime: "2026-11-24T10:00:00Z",
    ...extra,
  };
}

async function harness(opts: { myDay?: boolean; routes: Route[]; vars?: Record<string, string> }) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const db: DatabaseSync = openDatabase(":memory:");
  const { env, core } = buildNodeEnv(db, {
    TIMEZONE: "America/New_York",
    MS_TENANT_ID: "test-tenant",
    MS_CLIENT_ID: "test-client",
    MS_CLIENT_SECRET: "test-secret",
    OWNER_EMAIL: "test-owner@example.com",
    ENABLE_MY_DAY: opts.myDay ? "true" : "false",
    ENABLE_CHECKLIST_CACHE: "true",
    ...opts.vars,
  });
  await storeTokens(env, { access_token: "a", refresh_token: "r", expires_at: NOW + 3_600_000, scope: SCOPES, obtained_at: NOW });
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/oauth2/v2.0/token")) {
        return json({ token_type: "Bearer", scope: SCOPES, expires_in: 3600, access_token: "sub", refresh_token: "r" });
      }
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method, url, ...(body !== undefined ? { body } : {}), ...(headers["if-match"] ? { ifMatch: headers["if-match"] } : {}) });
      for (const r of opts.routes) {
        const res = r(method, url, body);
        if (res) return res;
      }
      return json({ error: { code: "Unscripted", message: `${method} ${url}` } }, 418);
    }),
  );
  const server = createMcpServer();
  registerTools(server, { env });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: res.isError ?? false, result: JSON.parse(res.content[0].text) as Record<string, unknown> };
  };
  const tasks = () => db.prepare("SELECT task_id AS id, list_id, title FROM tasks ORDER BY task_id").all();
  const sid = (graphId: string) =>
    (db.prepare("SELECT sid FROM entity_map WHERE kind = 'task' AND graph_id = ?").get(graphId) as { sid: string } | undefined)?.sid;
  return { env, core, db, calls, call, tasks, sid };
}

const on = (method: string, url: string, res: (body: unknown) => Response): Route => (m, u, b) =>
  m === method && u === url ? res(b) : undefined;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("task write tools", () => {
  it("create_task posts only supplied fields and indexes the task", async () => {
    const h = await harness({
      routes: [on("POST", `${G}/L1/tasks`, (b) => json(task("T1", b as Record<string, unknown>), 201))],
    });
    const r = await h.call("create_task", { list: "L1", title: "Call Acme", body: "notes", due: "2026-11-30", importance: "high", categories: ["x"] });
    expect(r).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
    expect(h.tasks()).toEqual([{ id: "T1", list_id: "L1", title: "Call Acme" }]);
  });

  it("create_task maps a missing list and a bad date", async () => {
    const h = await harness({ routes: [on("POST", `${G}/NOPE/tasks`, notFound)] });
    expect(await h.call("create_task", { list: "NOPE", title: "x" })).toMatchSnapshot();
    expect(await h.call("create_task", { list: "NOPE", title: "x", due: "not a date" })).toMatchSnapshot();
    expect(h.calls).toHaveLength(1);
  });

  it("update_task patches, re-fetches for link rules on a title change, and maps 412", async () => {
    let patches = 0;
    const h = await harness({
      routes: [
        on("PATCH", `${G}/L1/tasks/T1`, (b) => (++patches === 2 ? json({ error: { code: "PreconditionFailed" } }, 412) : json(task("T1", b as Record<string, unknown>)))),
        on("GET", `${G}/L1/tasks/T1?%24expand=linkedResources`, () => json(task("T1", { title: "renamed", linkedResources: [] }))),
      ],
    });
    expect(await h.call("update_task", { list: "L1", task_id: "T1", title: "renamed", due: null, if_match: "W/\"1\"" })).toMatchSnapshot();
    expect(h.tasks()).toEqual([{ id: "T1", list_id: "L1", title: "renamed" }]);
    expect(await h.call("update_task", { list: "L1", task_id: "T1", importance: "low" })).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
  });

  it("update_task backdates a completed task by resetting it first", async () => {
    const h = await harness({
      routes: [
        on("GET", `${G}/L1/tasks/T1`, () => json(task("T1", { status: "completed" }))),
        on("PATCH", `${G}/L1/tasks/T1`, (b) => json(task("T1", b as Record<string, unknown>))),
      ],
    });
    expect(await h.call("update_task", { list: "L1", task_id: "T1", completed_date: "2026-11-01", if_match: "e1" })).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
  });

  it("update_task refuses to backdate a recurring task and maps a missing task", async () => {
    const h = await harness({
      routes: [
        on("GET", `${G}/L1/tasks/T1`, () => json(task("T1", { recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "noEnd", startDate: "2026-11-01" } } }))),
        on("GET", `${G}/L1/tasks/GONE`, notFound),
        on("PATCH", `${G}/L1/tasks/GONE`, notFound),
      ],
    });
    expect(await h.call("update_task", { list: "L1", task_id: "T1", completed_date: "2026-11-01" })).toMatchSnapshot();
    expect(await h.call("update_task", { list: "L1", task_id: "GONE", completed_date: "2026-11-01" })).toMatchSnapshot();
    expect(await h.call("update_task", { list: "L1", task_id: "GONE", title: "x" })).toMatchSnapshot();
  });

  it("delete_task deletes and drops the index row; maps a missing task", async () => {
    const h = await harness({
      routes: [on("DELETE", `${G}/L1/tasks/T1`, noContent), on("DELETE", `${G}/L1/tasks/GONE`, notFound)],
    });
    h.core.upsertTask(task("T1") as never, "L1");
    expect(await h.call("delete_task", { list: "L1", task_id: "T1" })).toMatchSnapshot();
    expect(h.tasks()).toEqual([]);
    expect(await h.call("delete_task", { list: "L1", task_id: "GONE" })).toMatchSnapshot();
  });
});

describe("move_task", () => {
  it("re-parents through Substrate and re-keys the index", async () => {
    const h = await harness({
      myDay: true,
      routes: [
        on("GET", `${G}/L1/tasks/T1?%24expand=checklistItems%2ClinkedResources%2Cattachments`, () => json(task("T1"))),
        on("PATCH", `${S}/taskfolders/L2/tasks/T1`, () => json({ Id: "AAMkNEW", ParentFolderId: "L2" })),
      ],
    });
    h.core.upsertTask(task("T1") as never, "L1");
    h.core.upsertChecklistItem("T1", "L1", { id: "c1", displayName: "step" });
    expect(await h.call("move_task", { task_id: "T1", from_list: "L1", to_list: "L2" })).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
    expect(h.tasks()).toEqual([{ id: "T1", list_id: "L2", title: "title T1" }]);
    // The re-key moves the task's steps with it (an upsert alone would not).
    expect(h.db.prepare("SELECT list_id FROM checklist_items WHERE item_id = 'c1'").get()).toEqual({ list_id: "L2" });
  });

  it("treats an ambiguous re-parent as moved when the source is gone", async () => {
    const h = await harness({
      myDay: true,
      routes: [
        on("GET", `${G}/L1/tasks/T1?%24expand=checklistItems%2ClinkedResources%2Cattachments`, () => json(task("T1"))),
        on("PATCH", `${S}/taskfolders/L2/tasks/T1`, () => json({ error: "boom" }, 400)),
        on("GET", `${G}/L1/tasks/T1`, notFound),
      ],
    });
    h.core.upsertTask(task("T1") as never, "L1");
    expect(await h.call("move_task", { task_id: "T1", from_list: "L1", to_list: "L2" })).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
    expect(h.tasks()).toEqual([]);
  });

  it("copies then deletes when My Day is off", async () => {
    const h = await harness({
      routes: [
        on("GET", `${G}/L1/tasks/T1?%24expand=checklistItems%2ClinkedResources%2Cattachments`, () =>
          json(task("T1", {
            checklistItems: [
              { id: "c2", displayName: "second", isChecked: true, createdDateTime: "2026-11-21T00:00:00Z" },
              { id: "c1", displayName: "first", isChecked: false, createdDateTime: "2026-11-20T00:00:00Z" },
            ],
            linkedResources: [{ id: "k1", applicationName: "App", displayName: "Link", webUrl: "https://example.com" }],
          })),
        ),
        on("POST", `${G}/L2/tasks`, () => json(task("T2"), 201)),
        on("POST", `${G}/L2/tasks/T2/checklistItems`, (b) => json({ id: "n", ...(b as object) }, 201)),
        on("POST", `${G}/L2/tasks/T2/linkedResources`, (b) => json({ id: "nk", ...(b as object) }, 201)),
        on("DELETE", `${G}/L1/tasks/T1`, noContent),
      ],
    });
    h.core.upsertTask(task("T1") as never, "L1");
    const sid = h.sid("T1");
    expect(sid).toBeTruthy();
    expect(await h.call("move_task", { task_id: "T1", from_list: "L1", to_list: "L2" })).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
    expect(h.tasks()).toEqual([{ id: "T2", list_id: "L2", title: "title T2" }]);
    // The copy takes over the source's stable id, and its flags reflect what was copied.
    expect(h.sid("T2")).toBe(sid);
    expect(h.db.prepare("SELECT has_checklist FROM tasks WHERE task_id = 'T2'").get()).toEqual({ has_checklist: 1 });
  });

  it("falls back to a copy when a re-parent is unconfirmed and carries My Day", async () => {
    const h = await harness({
      myDay: true,
      routes: [
        on("GET", `${G}/L1/tasks/T1?%24expand=checklistItems%2ClinkedResources%2Cattachments`, () => json(task("T1"))),
        // 200 that ignored ParentFolderId: not confirmed.
        on("PATCH", `${S}/taskfolders/L2/tasks/T1`, () => json({ Id: "T1", ParentFolderId: "L1" })),
        on("GET", `${G}/L1/tasks/T1`, () => json(task("T1"))),
        on("POST", `${G}/L2/tasks`, () => json(task("T2"), 201)),
        on("GET", `${S}/taskfolders/L1/tasks/T1`, () => json({ Id: "T1", CommittedDay: "2026-11-24T00:00:00Z" })),
        on("PATCH", `${S}/taskfolders/L2/tasks/T2`, (b) => json({ Id: "T2", ...(b as object) })),
        on("DELETE", `${G}/L1/tasks/T1`, noContent),
      ],
    });
    h.core.upsertTask(task("T1") as never, "L1");
    const r = await h.call("move_task", { task_id: "T1", from_list: "L1", to_list: "L2" });
    expect(r.result).toMatchObject({ ok: true, method: "copy_delete", task_id: "T2", my_day_carried: true });
    expect(h.calls).toContainEqual({ method: "PATCH", url: `${S}/taskfolders/L2/tasks/T2`, body: { CommittedDay: "2026-11-24", PostponedDay: null } });
  });

  it("aborts the copy and cleans up the destination when a step copy fails", async () => {
    const h = await harness({
      routes: [
        on("GET", `${G}/L1/tasks/T1?%24expand=checklistItems%2ClinkedResources%2Cattachments`, () =>
          json(task("T1", { checklistItems: [{ id: "c1", displayName: "first" }] })),
        ),
        on("POST", `${G}/L2/tasks`, () => json(task("T2"), 201)),
        on("POST", `${G}/L2/tasks/T2/checklistItems`, () => json({ error: { code: "x" } }, 400)),
        on("DELETE", `${G}/L2/tasks/T2`, noContent),
      ],
    });
    expect(await h.call("move_task", { task_id: "T1", from_list: "L1", to_list: "L2" })).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
    expect(h.tasks()).toEqual([]);
  });

  it("maps a missing source task and a missing destination list", async () => {
    const h = await harness({
      routes: [
        on("GET", `${G}/L1/tasks/GONE?%24expand=checklistItems%2ClinkedResources%2Cattachments`, notFound),
        on("GET", `${G}/L1/tasks/T1?%24expand=checklistItems%2ClinkedResources%2Cattachments`, () => json(task("T1"))),
        on("POST", `${G}/NOPE/tasks`, notFound),
      ],
    });
    expect(await h.call("move_task", { task_id: "GONE", from_list: "L1", to_list: "L2" })).toMatchSnapshot();
    expect(await h.call("move_task", { task_id: "T1", from_list: "L1", to_list: "NOPE" })).toMatchSnapshot();
  });
});

describe("list write tools", () => {
  it("create, rename and delete a list, mapping 404 and 405", async () => {
    const h = await harness({
      routes: [
        on("POST", G, (b) => json({ id: "L9", displayName: (b as { displayName: string }).displayName }, 201)),
        on("PATCH", `${G}/L9`, (b) => json({ id: "L9", displayName: (b as { displayName: string }).displayName })),
        on("PATCH", `${G}/NOPE`, notFound),
        on("DELETE", `${G}/L9`, noContent),
        on("DELETE", `${G}/DEF`, () => json({ error: { code: "MethodNotAllowed" } }, 405)),
      ],
    });
    const listName = () => (h.db.prepare("SELECT display_name FROM lists WHERE list_id = 'L9'").get() as { display_name: string } | undefined)?.display_name;
    expect(await h.call("create_list", { display_name: "Errands" })).toMatchSnapshot();
    expect(listName()).toBe("Errands");
    expect(await h.call("update_list", { list: "L9", display_name: "Chores" })).toMatchSnapshot();
    expect(listName()).toBe("Chores");
    expect(await h.call("update_list", { list: "NOPE", display_name: "x" })).toMatchSnapshot();
    expect(await h.call("delete_list", { list: "DEF" })).toMatchSnapshot();
    expect(await h.call("delete_list", { list: "L9" })).toMatchSnapshot();
    expect(listName()).toBeUndefined();
    expect(h.calls).toMatchSnapshot();
  });
});

describe("checklist and linked-resource write tools", () => {
  it("creates, updates and deletes a step with the index write-through", async () => {
    const h = await harness({
      routes: [
        on("POST", `${G}/L1/tasks/T1/checklistItems`, (b) => json({ id: "c1", createdDateTime: "2026-11-24T15:00:00Z", ...(b as object) }, 201)),
        on("PATCH", `${G}/L1/tasks/T1/checklistItems/c1`, (b) => json({ id: "c1", displayName: "step", ...(b as object) })),
        on("PATCH", `${G}/L1/tasks/T1/checklistItems/gone`, notFound),
        on("DELETE", `${G}/L1/tasks/T1/checklistItems/c1`, noContent),
      ],
    });
    h.core.upsertTask(task("T1") as never, "L1");
    expect(await h.call("create_checklist_item", { task_id: "T1", display_name: "step" })).toMatchSnapshot();
    expect(h.db.prepare("SELECT item_id, display_name FROM checklist_items").all()).toEqual([{ item_id: "c1", display_name: "step" }]);
    expect(await h.call("update_checklist_item", { task_id: "T1", item_id: "c1", is_checked: true })).toMatchSnapshot();
    expect(await h.call("update_checklist_item", { list: "L1", task_id: "T1", item_id: "gone", display_name: "x" })).toMatchSnapshot();
    expect(await h.call("delete_checklist_item", { task_id: "T1", item_id: "c1" })).toMatchSnapshot();
    expect(h.db.prepare("SELECT count(*) n FROM checklist_items").get()).toEqual({ n: 0 });
    expect(await h.call("create_checklist_item", { task_id: "UNKNOWN", display_name: "x" })).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
  });

  it("creates, updates and deletes a linked resource", async () => {
    const h = await harness({
      routes: [
        on("POST", `${G}/L1/tasks/T1/linkedResources`, (b) => json({ id: "k1", ...(b as object) }, 201)),
        on("PATCH", `${G}/L1/tasks/T1/linkedResources/k1`, (b) => json({ id: "k1", applicationName: "App", ...(b as object) })),
        on("DELETE", `${G}/L1/tasks/T1/linkedResources/k1`, noContent),
        on("DELETE", `${G}/L1/tasks/T1/linkedResources/gone`, notFound),
      ],
    });
    expect(await h.call("create_linked_resource", { list: "L1", task_id: "T1", application_name: "App", web_url: "https://example.com" })).toMatchSnapshot();
    expect(await h.call("update_linked_resource", { list: "L1", task_id: "T1", resource_id: "k1", web_url: null, display_name: "D" })).toMatchSnapshot();
    expect(await h.call("delete_linked_resource", { list: "L1", task_id: "T1", resource_id: "k1" })).toMatchSnapshot();
    expect(await h.call("delete_linked_resource", { list: "L1", task_id: "T1", resource_id: "gone" })).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
  });
});

describe("My Day and manual-order write tools", () => {
  it("adds to and removes from My Day with the cache write-through", async () => {
    const h = await harness({
      myDay: true,
      routes: [
        on("PATCH", `${S}/taskfolders/L1/tasks/T1`, (b) => {
          const body = b as Record<string, unknown>;
          return body.CommittedDay
            ? json({ Id: "T1", Subject: "t", CommittedDay: "2026-11-24T00:00:00Z", CommittedOrder: body.CommittedOrder })
            : json({ Id: "T1", Subject: "t", CommittedDay: null, PostponedDay: "2026-11-24T00:00:00Z" });
        }),
      ],
    });
    h.core.upsertTask(task("T1") as never, "L1");
    expect(await h.call("add_to_my_day", { task_id: "T1" })).toMatchSnapshot();
    expect(h.core.getMyDayFields("T1")).toMatchSnapshot();
    expect(await h.call("add_to_my_day", { task_id: "T1", date: "24-11-2026" })).toMatchSnapshot();
    expect(await h.call("remove_from_my_day", { task_id: "T1", list: "L1" })).toMatchSnapshot();
    expect(h.core.getMyDayFields("T1")).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
  });

  it("refuses My Day writes when the feature is off", async () => {
    const h = await harness({ routes: [] });
    expect(await h.call("add_to_my_day", { task_id: "T1", list: "L1" })).toMatchSnapshot();
    expect(await h.call("reorder_task", { task_id: "T1", list: "L1", position: "top" })).toMatchSnapshot();
  });

  it("reorder_task computes positions from the folder's other tasks", async () => {
    const h = await harness({
      myDay: true,
      routes: [
        on("GET", `${S}/taskfolders/L1/tasks`, () =>
          json({ value: [
            { Id: "T1", OrderDateTime: "2026-11-01T00:00:00.000Z" },
            { Id: "T2", OrderDateTime: "2026-11-10T00:00:00.000Z" },
            { Id: "T3", OrderDateTime: "2026-11-05T00:00:00.000Z" },
          ] }),
        ),
        on("POST", "https://graph.microsoft.com/v1.0/me/translateExchangeIds", () => json({ value: [] })),
        on("GET", `${S}/taskfolders/L1/tasks/T3`, () => json({ Id: "T3", OrderDateTime: "2026-11-05T00:00:00.000Z" })),
        on("GET", `${S}/taskfolders/L1/tasks/T9`, () => json({ error: "nf" }, 404)),
        on("PATCH", `${S}/taskfolders/L1/tasks/T1`, (b) => json({ Id: "T1", Subject: "t", ...(b as object) })),
      ],
    });
    expect(await h.call("reorder_task", { task_id: "T1", list: "L1", position: "top" })).toMatchSnapshot();
    expect(await h.call("reorder_task", { task_id: "T1", list: "L1", position: "after", reference_task_id: "T3" })).toMatchSnapshot();
    expect(await h.call("reorder_task", { task_id: "T1", list: "L1", position: "before", reference_task_id: "T9" })).toMatchSnapshot();
    expect(await h.call("reorder_task", { task_id: "T1", list: "L1", position: "index" })).toMatchSnapshot();
    expect(await h.call("reorder_task", { task_id: "T1", list: "L1", position: "set", order_datetime: "nope" })).toMatchSnapshot();
    expect(await h.call("reorder_task", { task_id: "T1", list: "L1", position: "set", order_datetime: "2026-12-01T00:00:00.000Z" })).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
  });

  it("reorder_checklist_item returns the steps in their new order", async () => {
    const h = await harness({
      myDay: true,
      routes: [
        on("GET", `${S}/taskfolders/L1/tasks/T1?$select=*`, () =>
          json({ Id: "T1", Subtasks: [
            { Id: "s1", Subject: "one", OrderDateTime: "2026-11-03T00:00:00.000Z", IsCompleted: false },
            { Id: "s2", Subject: "two", OrderDateTime: "2026-11-02T00:00:00.000Z", IsCompleted: true },
            { Id: "s3", Subject: "three", OrderDateTime: null },
          ] }),
        ),
        on("PATCH", `${S}/tasks/T1/subtasks/s3`, (b) => json({ Id: "s3", ...(b as object) })),
      ],
    });
    expect(await h.call("reorder_checklist_item", { task_id: "T1", list: "L1", item_id: "s3", position: "before", reference_item_id: "s2" })).toMatchSnapshot();
    expect(await h.call("reorder_checklist_item", { task_id: "T1", list: "L1", item_id: "s3", position: "after", reference_item_id: "zz" })).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
  });

  it("reorder_checklist_item seeds unordered steps in their shown order before a relative move", async () => {
    // To Do leaves OrderDateTime null until a step is dragged; inserting below
    // one of those used to fail with reference_has_no_order.
    const h = await harness({
      myDay: true,
      routes: [
        on("GET", `${S}/taskfolders/L1/tasks/T1?$select=*`, () =>
          json({ Id: "T1", Subtasks: [
            { Id: "s2", Subject: "two", OrderDateTime: null, CreatedDateTime: "2026-11-02T00:00:00Z" },
            { Id: "s1", Subject: "one", OrderDateTime: null, CreatedDateTime: "2026-11-01T00:00:00Z" },
            { Id: "new", Subject: "one-a", OrderDateTime: null, CreatedDateTime: "2026-11-03T00:00:00Z" },
          ] }),
        ),
        on("PATCH", `${S}/tasks/T1/subtasks/s1`, (b) => json({ Id: "s1", ...(b as object) })),
        on("PATCH", `${S}/tasks/T1/subtasks/s2`, (b) => json({ Id: "s2", ...(b as object) })),
        on("PATCH", `${S}/tasks/T1/subtasks/new`, (b) => json({ Id: "new", ...(b as object) })),
      ],
    });
    const r = (await h.call("reorder_checklist_item", { task_id: "T1", list: "L1", item_id: "new", position: "after", reference_item_id: "s1" })) as unknown as {
      isError: boolean;
      result: { ordered_items: Array<{ item_id: string; order_datetime: string }> };
    };
    expect(r.isError).toBe(false);
    expect(r.result.ordered_items.map((i) => i.item_id)).toEqual(["s1", "new", "s2"]);
    const patches = h.calls.filter((c) => c.method === "PATCH");
    // Oldest unordered step first, the mover last.
    expect(patches.map((c) => c.url.split("/").pop())).toEqual(["s1", "s2", "new"]);
    const ms = Object.fromEntries(patches.map((c) => [c.url.split("/").pop(), Date.parse((c.body as { OrderDateTime: string }).OrderDateTime)]));
    expect([ms.s1 > ms.new, ms.new > ms.s2]).toEqual([true, true]);
  });

  it("reorder_checklist_item sends bottom below unordered steps, and leaves an all-ordered task alone", async () => {
    const h = await harness({
      myDay: true,
      routes: [
        on("GET", `${S}/taskfolders/L1/tasks/T1?$select=*`, () =>
          json({ Id: "T1", Subtasks: [
            { Id: "a", OrderDateTime: "2026-11-03T00:00:00Z" },
            { Id: "b", OrderDateTime: null, CreatedDateTime: "2026-11-01T00:00:00Z" },
          ] }),
        ),
        on("PATCH", `${S}/tasks/T1/subtasks/a`, (x) => json({ Id: "a", ...(x as object) })),
        on("PATCH", `${S}/tasks/T1/subtasks/b`, (x) => json({ Id: "b", ...(x as object) })),
      ],
    });
    const r = (await h.call("reorder_checklist_item", { task_id: "T1", list: "L1", item_id: "a", position: "bottom" })) as unknown as {
      result: { ordered_items: Array<{ item_id: string }> };
    };
    expect(r.result.ordered_items.map((i) => i.item_id)).toEqual(["b", "a"]);
    // b is seeded first (a is the one moving), then a goes below it.
    expect(h.calls.filter((c) => c.method === "PATCH").map((c) => c.url.split("/").pop())).toEqual(["b", "a"]);
  });

  it("reorder_my_day_task orders against the cached day", async () => {
    const h = await harness({
      myDay: true,
      routes: [on("PATCH", `${S}/taskfolders/L1/tasks/T1`, (b) => json({ Id: "T1", Subject: "t", CommittedDay: "2026-11-24T00:00:00Z", ...(b as object) }))],
    });
    for (const [id, order] of [["T1", "2026-11-24T10:00:00.000Z"], ["T2", "2026-11-24T12:00:00.000Z"], ["T3", "2026-11-24T11:00:00.000Z"]]) {
      h.core.upsertTask(task(id) as never, "L1");
      h.core.updateMyDayFields(id, { committed_day: "2026-11-24", committed_order: order });
    }
    expect(await h.call("reorder_my_day_task", { task_id: "T1", position: "before", reference_task_id: "T3", date: "2026-11-24" })).toMatchSnapshot();
    expect(h.core.getMyDayFields("T1")).toMatchSnapshot();
    expect(await h.call("reorder_my_day_task", { task_id: "T9", list: "L1", position: "top", date: "2026-11-24" })).toMatchSnapshot();
    expect(await h.call("reorder_my_day_task", { task_id: "T1", position: "set", committed_order: "2026-11-30T00:00:00.000Z", date: "2026-11-24" })).toMatchSnapshot();
    expect(h.calls).toMatchSnapshot();
  });
});

describe("error mapping at the tool boundary", () => {
  it("maps a Conditional Access claims challenge to reauth_required", async () => {
    const claims = btoa(JSON.stringify({ access_token: { acrs: { essential: true, value: "c1" } } }));
    const h = await harness({
      routes: [
        on("DELETE", `${G}/L1/tasks/T1`, () =>
          new Response("{}", { status: 401, headers: { "www-authenticate": `Bearer error="insufficient_claims", claims="${claims}"` } }),
        ),
      ],
    });
    const r = await h.call("delete_task", { list: "L1", task_id: "T1" });
    expect(r).toMatchObject({ isError: true, result: { ok: false, reason: "reauth_required" } });
  });

  it("maps Graph throttling past the retry budget to graph_429", async () => {
    const h = await harness({
      routes: [on("DELETE", `${G}/L1/tasks/T1`, () => new Response("{}", { status: 429, headers: { "retry-after": "0" } }))],
    });
    const r = await h.call("delete_task", { list: "L1", task_id: "T1" });
    expect(r).toMatchObject({ isError: true, result: { ok: false, reason: "graph_429" } });
  });

  it("maps a write that never got the write lease to write_busy, without writing", async () => {
    const h = await harness({ routes: [on("DELETE", `${G}/L1/tasks/T1`, noContent)] });
    // Another writer holds it past the whole wait: the index answers "no" and time has run out.
    vi.spyOn(h.core, "acquireWriteLease").mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 120_000);
      return { granted: false };
    });
    const r = await h.call("delete_task", { list: "L1", task_id: "T1" });
    expect(r).toMatchObject({ isError: true, result: { ok: false, reason: "write_busy" } });
    expect(h.calls).toEqual([]);
  });

  it("maps a busy lease to write_busy on the My Day tools too", async () => {
    const h = await harness({ myDay: true, routes: [] });
    vi.spyOn(h.core, "acquireWriteLease").mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 120_000);
      return { granted: false };
    });
    const r = await h.call("remove_from_my_day", { task_id: "T1", list: "L1" });
    expect(r).toMatchObject({ isError: true, result: { ok: false, reason: "write_busy" } });
  });
});

describe("create_upload_link", () => {
  const vars = { SERVICE_BASE_URL: "https://todo.test" };
  const live = (m: string, u: string) =>
    m === "GET" && u.startsWith(`${G}/L1/tasks/T2?`) ? json({ id: "T2", title: "fresh task" }) : undefined;
  const gone = (m: string, u: string) => (m === "GET" && u.startsWith(`${G}/L1/tasks/NOPE?`) ? notFound() : undefined);

  it("mints from the index without asking Graph when the task is mirrored in that list", async () => {
    const h = await harness({ routes: [], vars });
    h.core.upsertTask(task("T1") as never, "L1");
    const r = await h.call("create_upload_link", { list: "L1", task_id: "T1" });
    expect(r.isError).toBe(false);
    expect(r.result.task_title).toBe("title T1");
    expect(String(r.result.upload_url)).toMatch(/^https:\/\/todo\.test\/upload\?t=/);
    expect(h.calls).toEqual([]);
  });

  it("checks a task the index doesn't hold and labels the link with its live title", async () => {
    const h = await harness({ routes: [live], vars });
    const r = await h.call("create_upload_link", { list: "L1", task_id: "T2" });
    expect(r.isError).toBe(false);
    expect(r.result.task_title).toBe("fresh task");
    expect(h.calls).toHaveLength(1);
  });

  it("refuses a task that doesn't exist in the named list", async () => {
    const h = await harness({ routes: [gone], vars });
    const r = await h.call("create_upload_link", { list: "L1", task_id: "NOPE" });
    expect(r.isError).toBe(true);
    expect(r.result.reason).toBe("task_not_found");
  });

  it("checks live when the index has the task in a different list", async () => {
    const h = await harness({ routes: [gone], vars });
    h.core.upsertTask(task("NOPE") as never, "L9");
    const r = await h.call("create_upload_link", { list: "L1", task_id: "NOPE" });
    expect(r.result.reason).toBe("task_not_found");
  });
});
