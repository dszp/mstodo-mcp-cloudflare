// node:sqlite twin of test/sync-spike-sqlite.test.ts (docs/SYNC-API.md step 1).
import { describe, it, expect } from "vitest";
import { openDatabase, sqlDb } from "../src/hosts/node/sqlite-db";
import { runSyncLogSpike } from "../test/_sync-spike";

describe("sync spike: node:sqlite", () => {
  it("supports AUTOINCREMENT and trigger-minted random IDs", () => {
    const r = runSyncLogSpike(sqlDb(openDatabase(":memory:")));
    expect(r.seqAfterDeleteOfMax).toBeGreaterThan(r.maxBeforeDelete);
    expect(r.sid).toMatch(/^[0-9a-f]{32}$/);
    expect(r.sidStableAcrossUpdate).toBe(true);
    expect(r.noLogOnUnchangedUpdate).toBe(true);
    expect(r.tombstoneDeleted).toBe(1);
  });
});
