// Durable Object twin of test-node/change-feed.test.ts: the same checks on DO SQLite.
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { IndexCore } from "../src/core/index/index-core";
import { runChangeFeedChecks, runLargePageChecks, runManyListFilterChecks } from "./_change-feed-checks";

describe("change feed (Durable Object)", () => {
  it("serves full, paged, scoped and incremental pages", async () => {
    const stub = env.TODO_INDEX_DO.getByName("change-feed");
    await runInDurableObject(stub, async (_i, state) => {
      const c = new IndexCore({ sql: state.storage.sql, transact: (fn) => state.storage.transactionSync(fn), state: state.storage, alarms: state.storage, env: env as never });
      c.bootstrap();
      const r = await runChangeFeedChecks(c);
      for (const [name, ok] of Object.entries(r)) expect([name, ok]).toEqual([name, true]);
    });
  });

  it("serves a page larger than the bound-parameter limit", async () => {
    const stub = env.TODO_INDEX_DO.getByName("change-feed-large");
    await runInDurableObject(stub, async (_i, state) => {
      const c = new IndexCore({ sql: state.storage.sql, transact: (fn) => state.storage.transactionSync(fn), state: state.storage, alarms: state.storage, env: env as never });
      c.bootstrap();
      const r = runLargePageChecks(c);
      for (const [name, ok] of Object.entries(r)) expect([name, ok]).toEqual([name, true]);
    });
  });

  it("filters by more lists than the bound-parameter limit", async () => {
    const stub = env.TODO_INDEX_DO.getByName("many-list-filters");
    await runInDurableObject(stub, async (_i, state) => {
      const c = new IndexCore({ sql: state.storage.sql, transact: (fn) => state.storage.transactionSync(fn), state: state.storage, alarms: state.storage, env: env as never });
      c.bootstrap();
      const r = runManyListFilterChecks(c);
      for (const [name, ok] of Object.entries(r)) expect([name, ok]).toEqual([name, true]);
    });
  });
});
