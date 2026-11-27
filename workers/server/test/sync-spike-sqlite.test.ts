// Spike for docs/SYNC-API.md build step 1: the change log (section 3) relies on
// AUTOINCREMENT (sqlite_sequence) and on a trigger minting a random ID with
// randomblob(). PRAGMA user_version is refused in Durable Object SQLite
// (migrations.ts), so neither feature is assumed: this proves both work in the
// real DO SQLite the Workers pool runs. test-node/sync-spike-sqlite.test.ts
// proves the same on node:sqlite.
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { TodoIndex } from "../src/hosts/cloudflare/todo-index-do";
import { runSyncLogSpike } from "./_sync-spike";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("sync spike: DO SQLite", () => {
  it("supports AUTOINCREMENT and trigger-minted random IDs", async () => {
    const stub = env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName("sync-spike"));
    await runInDurableObject(stub, async (_: TodoIndex, ctx) => {
      const r = runSyncLogSpike(ctx.storage.sql);
      expect(r.seqs).toEqual([...r.seqs].sort((a, b) => a - b));
      expect(r.seqAfterDeleteOfMax).toBeGreaterThan(r.maxBeforeDelete);
      expect(r.sid).toMatch(/^[0-9a-f]{32}$/);
      expect(r.sidStableAcrossUpdate).toBe(true);
      expect(r.noLogOnUnchangedUpdate).toBe(true);
      expect(r.tombstoneDeleted).toBe(1);
    });
  });
});
