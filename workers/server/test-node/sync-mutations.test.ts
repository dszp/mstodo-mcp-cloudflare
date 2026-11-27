// Mutation batch (docs/SYNC-API.md sections 5 and 6) on node:sqlite.
import { describe, it, expect } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "@potem/core/index/index-core";
import { parseBatch, applyBatch } from "@potem/core/sync/mutations";
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

describe("sidebar neighbours", () => {
  it("skips a reorder or group op whose neighbour's create in the batch didn't apply", async () => {
    const c = core();
    const G = "0190a1b2c3d47e5f8a9b0000000000e1";
    const L = "0190a1b2c3d47e5f8a9b0000000000e2";
    const ran: string[] = [];
    const exec = async (input: { op: string }) => {
      ran.push(input.op);
      return { ok: false as const, error: "substrate_503", retry: true };
    };
    const at = "2026-11-24T00:00:00Z";
    const r = await applyBatch(storeOf(c), exec as never, {
      mutations: [
        { id: "a", at, op: "list_group.create", sid: G, fields: { name: "Work" } },
        { id: "b", at, op: "list.reorder", sid: "0190a1b2c3d47e5f8a9b0000000000e3", position: { after: G } },
        { id: "c", at, op: "list_group.reorder", sid: "0190a1b2c3d47e5f8a9b0000000000e4", position: { before: G } },
        { id: "d", at, op: "list.create", sid: L, fields: { name: "L" } },
        { id: "e", at, op: "list_group.create", sid: "0190a1b2c3d47e5f8a9b0000000000e5", fields: { name: "X" }, position: { after: L } },
      ],
    }, "p");
    expect(r.results.map((x) => x.status)).toEqual(["failed", "skipped", "skipped", "failed", "skipped"]);
    expect(ran).toEqual(["list_group.create", "list.create"]);
  });
});
