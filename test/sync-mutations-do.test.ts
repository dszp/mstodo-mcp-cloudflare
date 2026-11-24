// Durable Object twin of test-node/sync-mutations.test.ts.
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { IndexCore } from "../src/core/index/index-core";
import { runMutationChecks } from "./_mutation-checks";

describe("mutations (Durable Object)", () => {
  it("applies, dedupes, supersedes and rejects", async () => {
    const stub = env.TODO_INDEX_DO.getByName("mutations");
    await runInDurableObject(stub, async (_i, state) => {
      const c = new IndexCore({ sql: state.storage.sql, transact: (fn) => state.storage.transactionSync(fn), state: state.storage, alarms: state.storage, env: env as never });
      c.bootstrap();
      const r = await runMutationChecks(c);
      for (const [name, ok] of Object.entries(r)) expect([name, ok]).toEqual([name, true]);
    });
  });
});
