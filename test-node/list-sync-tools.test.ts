// The list sync setting (docs/SYNC-API.md section 1.2) through the MCP tools,
// end to end: a real McpServer + Client, the in-process IndexCore, and a
// scripted fetch (same harness shape as write-tools.test.ts).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { buildNodeEnv } from "../src/hosts/node/env";
import { SCOPES, storeTokens } from "../src/core/auth/microsoft";
import { loadListsConfig, storeListsConfig } from "../src/core/config/loader";
import { ListsConfigSchema } from "../src/core/config/schemas";
import { createMcpServer } from "../src/core/mcp/server";
import { registerTools } from "../src/core/mcp/register-tools";

const G = "https://graph.microsoft.com/v1.0/me/todo/lists";

type Route = (method: string, url: string, body: unknown) => Response | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const on = (method: string, url: string, res: (body: unknown) => Response): Route => (m, u, b) =>
  m === method && u === url ? res(b) : undefined;

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

async function harness(routes: Route[] = [], extraEnv: Record<string, string> = {}) {
  const db: DatabaseSync = openDatabase(":memory:");
  const { env, core } = buildNodeEnv(db, {
    TIMEZONE: "UTC",
    MS_TENANT_ID: "test-tenant",
    MS_CLIENT_ID: "test-client",
    MS_CLIENT_SECRET: "test-secret",
    OWNER_EMAIL: "test-owner@example.com",
    ENABLE_MY_DAY: "false",
    ENABLE_CHECKLIST_CACHE: "true",
    ...extraEnv,
  });
  await storeTokens(env, { access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000, scope: SCOPES, obtained_at: Date.now() });
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url });
      for (const r of routes) {
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
    return JSON.parse(res.content[0].text) as Record<string, unknown>;
  };
  const tasks = () => db.prepare("SELECT task_id AS id, list_id FROM tasks ORDER BY task_id").all();
  const syncOf = (listId: string) => (db.prepare("SELECT sync FROM lists WHERE list_id = ?").get(listId) as { sync: string | null } | undefined)?.sync;
  return { env, core, db, calls, call, tasks, syncOf };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("set_list_config overrides merge per key", () => {
  it("changes only the named pins, and null removes one", async () => {
    const h = await harness();
    await storeListsConfig(h.env, ListsConfigSchema.parse({ overrides: { A: "todo", B: "reference", C: "excluded" } }));
    const r = await h.call("set_list_config", { overrides: { A: "excluded", C: null } });
    expect(r).toMatchObject({ ok: true, override_count: 2 });
    expect((await loadListsConfig(h.env)).overrides).toEqual({ A: "excluded", B: "reference" });
  });

  it("leaves the pins alone when overrides is omitted", async () => {
    const h = await harness();
    await storeListsConfig(h.env, ListsConfigSchema.parse({ overrides: { A: "reference" } }));
    await h.call("set_list_config", { no_sync: ["X"] });
    expect(await loadListsConfig(h.env)).toMatchObject({ overrides: { A: "reference" }, no_sync: ["X"] });
  });

  it("applies the change in the index at once", async () => {
    const h = await harness();
    h.core.upsertList({ id: "L1", displayName: "One" } as never);
    h.core.upsertTask(task("T1") as never, "L1");
    await h.call("set_list_config", { overrides: { L1: "excluded" } });
    expect(h.syncOf("L1")).toBe("excluded");
    expect(h.tasks()).toEqual([]);
  });
});

describe("set_list_alias", () => {
  it("keeps the pins and the legacy arrays", async () => {
    const h = await harness();
    h.core.upsertList({ id: "L1", displayName: "One" } as never);
    await storeListsConfig(h.env, ListsConfigSchema.parse({ overrides: { L1: "excluded" }, archive: ["L9"] }));
    expect(await h.call("set_list_alias", { alias: "one", list_id_or_name: "L1" })).toMatchObject({ ok: true });
    expect(await loadListsConfig(h.env)).toMatchObject({ aliases: { one: "L1" }, overrides: { L1: "excluded" }, archive: ["L9"] });
  });
});

describe("write tools into an excluded list", () => {
  it("create_task succeeds in Graph and leaves no row in the mirror", async () => {
    const h = await harness([on("POST", `${G}/LX/tasks`, (b) => json(task("T1", b as Record<string, unknown>), 201))]);
    h.core.upsertList({ id: "LT", displayName: "Todo" } as never);
    h.core.upsertList({ id: "LX", displayName: "Excluded" } as never);
    await h.core.updateListsConfig({ overrides: { LX: "excluded" } });
    h.core.upsertTask(task("T2") as never, "LT");
    expect(await h.call("create_task", { list: "LX", title: "x" })).toMatchObject({ ok: true });
    expect(h.tasks()).toEqual([{ id: "T2", list_id: "LT" }]);
    expect(h.calls.some((c) => c.method === "POST" && c.url === `${G}/LX/tasks`)).toBe(true);
  });
});

describe("create_list", () => {
  it("pins the new list todo, so a name matching an excluded pattern can't exclude it", async () => {
    const h = await harness([on("POST", G, (b) => json({ id: "LNEW", ...(b as Record<string, unknown>) }, 201))]);
    await storeListsConfig(h.env, ListsConfigSchema.parse({ patterns: [{ pattern: "^Junk", type: "excluded" }] }));
    expect(await h.call("create_list", { display_name: "Junk drawer" })).toMatchObject({ ok: true });
    expect((await loadListsConfig(h.env)).overrides).toEqual({ LNEW: "todo" });
    expect(h.syncOf("LNEW")).toBe("todo");
  });
});

describe("reads filtered to an excluded list", () => {
  async function withLists(routes: Route[] = []) {
    const h = await harness(routes);
    h.core.upsertList({ id: "LT", displayName: "Todo" } as never);
    h.core.upsertList({ id: "LX", displayName: "Excluded" } as never);
    await h.core.updateListsConfig({ overrides: { LX: "excluded" } });
    h.core.upsertTask(task("T1") as never, "LT");
    return h;
  }
  const marker = { not_mirrored: [{ list_id: "LX", display_name: "Excluded" }], not_mirrored_note: expect.any(String) };

  it("name the excluded list in query_tasks, search_tasks and search_checklist_items", async () => {
    const h = await withLists();
    expect(await h.call("query_tasks", { lists: ["LX"] })).toMatchObject({ ok: true, count: 0, ...marker });
    expect(await h.call("query_tasks", { types: ["excluded"] })).toMatchObject({ ok: true, count: 0, ...marker });
    expect(await h.call("search_tasks", { query: "title", lists: ["LT", "LX"] })).toMatchObject({ ok: true, count: 1, ...marker });
    expect(await h.call("search_checklist_items", { lists: ["LX"] })).toMatchObject({ ok: true, ...marker });
  });

  it("name it in get_recently_completed and get_pending_across_lists", async () => {
    const h = await withLists();
    expect(await h.call("get_recently_completed", { list: "LX" })).toMatchObject({ ok: true, ...marker });
    await h.core.updateListsConfig({ patterns: [{ pattern: "^Todo", flags: "i", type: "todo" }] });
    expect(await h.call("get_pending_across_lists", { type: "excluded" })).toMatchObject({ ok: true, count: 0, ...marker });
    expect(await h.call("get_pending_across_lists", {})).not.toHaveProperty("not_mirrored");
  });

  it("leave a todo-only read unchanged", async () => {
    const h = await withLists();
    const r = await h.call("query_tasks", { lists: ["LT"] });
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(r).not.toHaveProperty("not_mirrored");
  });

  it("list_tasks pages an excluded list live from Graph", async () => {
    const first = `${G}/LX/tasks?%24top=1`;
    const second = `${G}/LX/tasks?%24top=1&%24skip=1`;
    const h = await withLists([
      on("GET", first, () => json({ value: [task("X1")], "@odata.nextLink": second })),
      on("GET", second, () => json({ value: [task("X2")] })),
    ]);
    const p1 = await h.call("list_tasks", { list: "LX", top: 1 });
    expect(p1).toMatchObject({ ok: true, source: "graph", count: 1, ...marker });
    expect(p1.next_cursor).toEqual(expect.any(String));
    const p2 = await h.call("list_tasks", { list: "LX", cursor: p1.next_cursor });
    expect(p2).toMatchObject({ ok: true, source: "graph", count: 1, tasks: [{ id: "X2" }] });
    expect(p2).not.toHaveProperty("next_cursor");
    expect(h.calls.map((c) => c.url)).toEqual([first, second]);
  });

  it("list_tasks refuses a cursor that points anywhere but that list's tasks", async () => {
    const h = await withLists();
    const forge = (url: string) => "g." + btoa(url).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const url of [`${G}/LT/tasks?%24skip=1`, "https://evil.example/v1.0/me/todo/lists/LX/tasks"]) {
      expect(await h.call("list_tasks", { list: "LX", cursor: forge(url) })).toMatchObject({ ok: false, reason: "invalid_cursor" });
    }
    expect(h.calls).toEqual([]);
  });

  it("list_tasks on a todo list keeps its one-page cold read", async () => {
    const h = await withLists([
      on("GET", `${G}/LT/tasks?%24top=50`, () => json({ value: [task("T1")], "@odata.nextLink": `${G}/LT/tasks?%24skip=50` })),
    ]);
    const r = await h.call("list_tasks", { list: "LT" });
    expect(r).toMatchObject({ ok: true, source: "graph_cold", count: 1 });
    expect(r).not.toHaveProperty("next_cursor");
    expect(r).not.toHaveProperty("not_mirrored");
  });
});

describe("list_lists auto-pin", () => {
  it("doesn't replace a pin newer than its own read of the config", async () => {
    const h = await harness();
    h.core.upsertList({ id: "X", displayName: "Junk drawer" } as never);
    const patterns = [{ pattern: "^Junk", flags: "i", type: "excluded" as const }];
    await h.core.updateListsConfig({ patterns, overrides: { X: "todo" } });
    // The Worker's KV read still predates the pin.
    await storeListsConfig(h.env, ListsConfigSchema.parse({ patterns }));
    const r = await h.call("list_lists", {});
    expect(r).toMatchObject({ ok: true, lists: [{ id: "X", type: "todo" }] });
    expect(h.syncOf("X")).toBe("todo");
    expect((await h.core.listsConfig()).overrides).toEqual({ X: "todo" });
  });

  it("shows a setting KV doesn't have yet", async () => {
    const h = await harness();
    h.core.upsertList({ id: "X", displayName: "Junk drawer" } as never);
    await storeListsConfig(h.env, ListsConfigSchema.parse({}));
    await h.core.updateListsConfig({ overrides: { X: "excluded" } });
    // KV lags the change (eventual consistency); the tools must not.
    await storeListsConfig(h.env, ListsConfigSchema.parse({}));
    expect(await h.call("get_list_config", {})).toMatchObject({ ok: true, override_count: 1 });
    expect(await h.call("list_lists", {})).toMatchObject({ ok: true, lists: [{ id: "X", type: "excluded" }] });
  });

  it("goes back to KV once the pending config is 90 seconds old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const h = await harness();
      await h.core.updateListsConfig({ overrides: { X: "excluded" } });
      // Something else wrote KV after the change; while the change is
      // pending the index still prefers its own copy.
      await storeListsConfig(h.env, ListsConfigSchema.parse({ overrides: { X: "reference" } }));
      expect((await h.core.listsConfig()).overrides).toEqual({ X: "excluded" });
      vi.setSystemTime(Date.now() + 89_000);
      expect((await h.core.listsConfig()).overrides).toEqual({ X: "excluded" });
      vi.setSystemTime(Date.now() + 2_000);
      expect((await h.core.listsConfig()).overrides).toEqual({ X: "reference" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("list_my_day_tasks", () => {
  const tokenRoute: Route = (_m, u) =>
    u.endsWith("/oauth2/v2.0/token")
      ? json({ token_type: "Bearer", scope: SCOPES, expires_in: 3600, access_token: "sub", refresh_token: "r" })
      : undefined;

  it("names the excluded lists, whose My Day tasks it can't show", async () => {
    const h = await harness([tokenRoute], { ENABLE_MY_DAY: "true" });
    h.core.upsertList({ id: "LT", displayName: "Todo" } as never);
    h.core.upsertList({ id: "LF", displayName: "Flagged Emails", wellknownListName: "flaggedEmails" } as never);
    await h.core.updateListsConfig({ overrides: { LF: "excluded" } });
    expect(await h.call("list_my_day_tasks", {})).toMatchObject({
      ok: true,
      not_mirrored: [{ list_id: "LF", display_name: "Flagged Emails" }],
      not_mirrored_note: expect.any(String),
    });
  });

  it("adds nothing when no list is excluded", async () => {
    const h = await harness([tokenRoute], { ENABLE_MY_DAY: "true" });
    h.core.upsertList({ id: "LT", displayName: "Todo" } as never);
    await h.core.updateListsConfig({ overrides: { LT: "todo" } });
    const r = await h.call("list_my_day_tasks", {});
    expect(r).toMatchObject({ ok: true });
    expect(r).not.toHaveProperty("not_mirrored");
  });
});
