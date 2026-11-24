// Durable Object twin of test-node/list-appearance.test.ts: the same checks on DO SQLite.
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { IndexCore } from "../src/core/index/index-core";
import {
  runListAppearanceCycleChecks,
  runListAppearanceFeedChecks,
  runListAppearanceMigrationChecks,
  runListAppearanceRefusedChecks,
} from "./_list-appearance-checks";

const core = (state: DurableObjectState) =>
  new IndexCore({ sql: state.storage.sql, transact: (fn) => state.storage.transactionSync(fn), state: state.storage, alarms: state.storage, env: env as never });

function check(r: Record<string, boolean>) {
  for (const [name, ok] of Object.entries(r)) expect([name, ok]).toEqual([name, true]);
}

describe("list appearance (Durable Object)", () => {
  it("migrates a v11 database", async () => {
    await runInDurableObject(env.TODO_INDEX_DO.getByName("appearance-migration"), async (_i, state) => {
      check(runListAppearanceMigrationChecks(state.storage.sql));
    });
  });

  it("serves groups, order and theme in the feed", async () => {
    await runInDurableObject(env.TODO_INDEX_DO.getByName("appearance-feed"), async (_i, state) => {
      const c = core(state);
      c.bootstrap();
      const r = await runListAppearanceFeedChecks(c);
      await state.storage.deleteAlarm();
      check(r);
    });
  });

  it("reads the sidebar on a budget and survives Substrate failures", async () => {
    await runInDurableObject(env.TODO_INDEX_DO.getByName("appearance-cycle"), async (_i, state) => {
      const c = core(state);
      c.bootstrap();
      const r = await runListAppearanceCycleChecks(c, env as never, state.storage.sql);
      await state.storage.deleteAlarm();
      check(r);
    });
  });

  it("leaves appearance null when the Exchange Online scope is refused", async () => {
    await runInDurableObject(env.TODO_INDEX_DO.getByName("appearance-refused"), async (_i, state) => {
      const c = core(state);
      c.bootstrap();
      const r = await runListAppearanceRefusedChecks(c, env as never);
      await state.storage.deleteAlarm();
      check(r);
    });
  });
});
