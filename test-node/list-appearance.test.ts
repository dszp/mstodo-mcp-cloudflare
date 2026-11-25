// List groups, sidebar order and theme (docs/SYNC-API.md section 10.4) on node:sqlite.
import { describe, it, expect, vi } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";
import { SCOPES, storeTokens } from "../src/core/auth/microsoft";
import {
  runListAppearanceCycleChecks,
  runListAppearanceFeedChecks,
  runListAppearanceIdentityChecks,
  runListAppearanceMigrationChecks,
  runListAppearanceRefusedChecks,
  runListAppearanceSupersededChecks,
} from "../test/_list-appearance-checks";

function memoryKv() {
  const m = new Map<string, string>();
  return {
    get: async (k: string, t?: string) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)!) : m.get(k)) : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}

function core(extra: Record<string, string> = {}) {
  const db = openDatabase(":memory:");
  const state = stateStore(db);
  const env = {
    TIMEZONE: "UTC",
    OWNER_EMAIL: "o@example.com",
    MS_TENANT_ID: "t",
    MS_CLIENT_ID: "c",
    MS_CLIENT_SECRET: "test-secret",
    ENABLE_MY_DAY: "true",
    TODO_CACHE: memoryKv(),
    ...extra,
  } as never;
  const c = new IndexCore({ sql: sqlDb(db), transact: transactor(db), state, alarms: state, env });
  c.bootstrap();
  return { c, env, sql: sqlDb(db), state };
}

describe("list appearance: migration v12 (node)", () => {
  const r = runListAppearanceMigrationChecks(sqlDb(openDatabase(":memory:")));
  for (const [name, ok] of Object.entries(r)) it(name, () => expect(ok).toBe(true));
});

describe("list appearance: change feed (node)", async () => {
  const r = await runListAppearanceFeedChecks(core().c);
  for (const [name, ok] of Object.entries(r)) it(name, () => expect(ok).toBe(true));
});

describe("list appearance: sync cycle (node)", async () => {
  const { c, env, sql, state } = core();
  const r = await runListAppearanceCycleChecks(c, env, sql, state);
  for (const [name, ok] of Object.entries(r)) it(name, () => expect(ok).toBe(true));
});

describe("list appearance: owner change during the read (node)", async () => {
  const { c, env, sql } = core();
  const r = await runListAppearanceIdentityChecks(c, env, sql);
  for (const [name, ok] of Object.entries(r)) it(name, () => expect(ok).toBe(true));
});

describe("list appearance: a write during the read (node)", async () => {
  const { c, env, sql } = core();
  const r = await runListAppearanceSupersededChecks(c, env, sql);
  for (const [name, ok] of Object.entries(r)) it(name, () => expect(ok).toBe(true));
});

describe("list appearance: Exchange Online scope refused (node)", async () => {
  const { c, env } = core();
  const r = await runListAppearanceRefusedChecks(c, env);
  for (const [name, ok] of Object.entries(r)) it(name, () => expect(ok).toBe(true));
});

describe("list appearance: My Day off (node)", () => {
  it("makes no Substrate call and reports list_appearance off", async () => {
    const { c, env } = core({ ENABLE_MY_DAY: "false" });
    await storeTokens(env, { access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000, scope: SCOPES, obtained_at: Date.now() });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        urls.push(url);
        if (url.includes("/me/todo/lists/delta")) {
          return Response.json({ value: [{ id: "N1", displayName: "N1" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/todo/lists/delta?d=1" });
        }
        if (url.includes("/tasks/delta")) return Response.json({ value: [], "@odata.deltaLink": `${url.split("?")[0]}?d=1` });
        return new Response("unscripted", { status: 404 });
      }),
    );
    try {
      await c.runSyncCycle();
      expect(urls.some((u) => u.includes("substrate.office.com"))).toBe(false);
      expect(c.getList("N1")?.theme_color ?? null).toBeNull();
      const caps = (await c.syncInfo()).capabilities;
      expect(caps.list_appearance).toBe(false);
      expect(caps.list_appearance_write).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
