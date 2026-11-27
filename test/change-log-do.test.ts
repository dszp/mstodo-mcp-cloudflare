// Durable Object twin of test-node/change-log.test.ts: the same checks on DO SQLite.
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { IndexCore } from "@potem/core/index/index-core";
import { runChangeLogChecks } from "./_change-log-checks";

describe("change log (Durable Object)", () => {
  it("logs every writer and keeps stable IDs", async () => {
    const stub = env.TODO_INDEX_DO.getByName("change-log");
    await runInDurableObject(stub, async (_i, state) => {
      const c = new IndexCore({ sql: state.storage.sql, transact: (fn) => state.storage.transactionSync(fn), state: state.storage, alarms: state.storage, env: env as never });
      c.bootstrap();
      const r = runChangeLogChecks(c, state.storage.sql);
      for (const [name, ok] of Object.entries(r)) expect([name, ok]).toEqual([name, true]);
    });
  });
});
