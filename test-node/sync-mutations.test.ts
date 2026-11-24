// Mutation batch (docs/SYNC-API.md sections 5 and 6) on node:sqlite.
import { describe, it, expect } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";
import { parseBatch, applyBatch } from "../src/core/sync/mutations";
import { runMutationChecks, storeOf } from "../test/_mutation-checks";

function core() {
  const db = openDatabase(":memory:");
  const state = stateStore(db);
  const c = new IndexCore({ sql: sqlDb(db), transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  return c;
}

describe("mutations (node)", async () => {
  const r = await runMutationChecks(core());
  for (const [name, ok] of Object.entries(r)) it(name, () => expect(ok).toBe(true));
});

describe("parseBatch", () => {
  it("refuses a malformed batch as a whole", () => {
    expect(parseBatch(null)).toBe("body must be a JSON object");
    expect(parseBatch({ mutations: [] })).toBe("client_id required");
    expect(parseBatch({ client_id: "mac", mutations: Array(26).fill({}) })).toMatch(/at most 25/);
    expect(parseBatch({ client_id: "mac", mutations: [] })).toEqual({ client_id: "mac", mutations: [] });
  });
});

describe("time budget", () => {
  it("skips what's left when the budget runs out", async () => {
    const c = core();
    let t = 0;
    const r = await applyBatch(storeOf(c), async () => ({ ok: true, graphId: "x" }), {
      mutations: [
        { id: "a", at: "2026-11-24T00:00:00Z", op: "task.update", sid: "11111111111111111111111111111111", fields: { title: "x" } },
        { id: "b", at: "2026-11-24T00:00:00Z", op: "task.update", sid: "22222222222222222222222222222222", fields: { title: "x" } },
      ],
    }, "p", { now: () => (t += 30_000), budgetMs: 20_000 });
    expect(r.results.map((x) => x.status)).toEqual(["skipped", "skipped"]);
  });
});
