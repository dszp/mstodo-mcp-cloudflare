// List sync setting (docs/SYNC-API.md section 1.2) on node:sqlite.
import { describe, it, expect } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";
import { runListSyncChecks } from "../test/_list-sync-checks";

function memoryKv() {
  const m = new Map<string, string>();
  return {
    get: async (k: string, t?: string) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)!) : m.get(k)) : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}

describe("list sync setting (node)", async () => {
  const db = openDatabase(":memory:");
  const state = stateStore(db);
  const env = { TIMEZONE: "UTC", OWNER_EMAIL: "o@example.com", TODO_CACHE: memoryKv() } as never;
  const c = new IndexCore({ sql: sqlDb(db), transact: transactor(db), state, alarms: state, env });
  c.bootstrap();
  const r = await runListSyncChecks(c, env);
  for (const [name, ok] of Object.entries(r)) it(name, () => expect(ok).toBe(true));
});
