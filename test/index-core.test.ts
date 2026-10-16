// test/index-core.test.ts
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { IndexCore } from "../src/core/index/index-core";

describe("IndexCore", () => {
  it("runs over injected ports", async () => {
    const stub = env.TODO_INDEX_DO.getByName("index-core-test");
    await runInDurableObject(stub, async (_inst, state) => {
      const core = new IndexCore({ sql: state.storage.sql, state: state.storage, alarms: state.storage, env: env as never });
      core.bootstrap();
      core.upsertList({ id: "L1", displayName: "Inbox" } as never);
      expect(core.listLists().map((l) => l.list_id)).toEqual(["L1"]);
      const a = (await core.authState()).epoch;
      expect(await core.revokeAllGrants()).not.toBe(a);
    });
  });
});
