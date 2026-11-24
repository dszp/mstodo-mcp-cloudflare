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

async function harness(routes: Route[] = []) {
  const db: DatabaseSync = openDatabase(":memory:");
  const { env, core } = buildNodeEnv(db, {
    TIMEZONE: "UTC",
    MS_TENANT_ID: "test-tenant",
    MS_CLIENT_ID: "test-client",
    MS_CLIENT_SECRET: "test-secret",
    OWNER_EMAIL: "test-owner@example.com",
    ENABLE_MY_DAY: "false",
    ENABLE_CHECKLIST_CACHE: "true",
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
