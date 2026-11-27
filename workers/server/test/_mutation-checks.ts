// Shared assertions for the mutation batch (docs/SYNC-API.md sections 5 and
// 6), run on both hosts' SQLite through IndexCore with a fake executor in
// place of Graph. Returns named facts so each host asserts them one by one.
import type { IndexCore } from "@potem/core/index/index-core";
import { applyBatch, type ExecInput, type Executor, type MutationStore } from "@potem/core/sync/mutations";

export function storeOf(c: IndexCore): MutationStore {
  return {
    mutationBegin: async (...a) => c.mutationBegin(...a),
    mutationFinish: async (...a) => c.mutationFinish(...a),
    mutationAbandon: async (...a) => c.mutationAbandon(...a),
    mutationRelease: async (...a) => c.mutationRelease(...a),
    fieldClocks: async (...a) => c.fieldClocks(...a),
    resolveSids: async (...a) => c.resolveSids(...a),
    adoptSid: async (...a) => c.adoptSid(...a),
    syncCursor: async () => c.syncCursor(),
  };
}

const sidOf = (c: IndexCore, kind: string, graphId: string) =>
  kind === "task" ? c.syncTaskSids([graphId])[graphId] : undefined;

export async function runMutationChecks(c: IndexCore) {
  const store = storeOf(c);
  const calls: ExecInput[] = [];
  let n = 0;
  let failNext: { error: string; retry: boolean } | null = null;
  // Stands in for the ops layer: "creates" in Graph and writes the mirror.
  const exec: Executor = async (input) => {
    calls.push(input);
    if (failNext) {
      const f = failNext;
      failNext = null;
      return { ok: false, ...f };
    }
    if (input.op === "task.create") {
      const id = `G${++n}`;
      c.upsertTask({ id, title: String(input.fields.title), status: "notStarted", lastModifiedDateTime: new Date().toISOString() } as never, input.ids[input.fields.list_id as string]);
      return { ok: true, graphId: id };
    }
    if (input.op === "task.update") {
      c.upsertTask({ id: input.graphId!, title: String(input.fields.title ?? "x"), status: "notStarted", lastModifiedDateTime: new Date(Date.now() + ++n * 1000).toISOString() } as never, "L1");
      return { ok: true, graphId: input.graphId! };
    }
    if (input.op === "task.delete") {
      c.deleteTask(input.graphId!);
      return { ok: true, graphId: input.graphId! };
    }
    return { ok: false, error: "not_in_fake", retry: false, rejected: true };
  };

  c.upsertList({ id: "L1", displayName: "One" } as never);
  const feed = c.syncChanges({});
  const listSid = feed.ok ? feed.page.changes.find((x) => x.kind === "list")!.id : "";

  const appSid = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const create = { id: "m-1", at: t0, op: "task.create", sid: appSid, fields: { list_id: listSid, title: "Call Acme" } };
  const r1 = await applyBatch(store, exec, { mutations: [create] }, "p");
  const created = c.syncTask(appSid);
  const createClocks = c.fieldClocks("task", appSid.toLowerCase());
  const retry = await applyBatch(store, exec, { mutations: [create] }, "p");

  // Field clocks: an update made at t2 lands; a queued one made earlier
  // (t1 < t2) is superseded for title.
  const t1 = new Date(Date.now() - 50_000).toISOString();
  const t2 = new Date(Date.now() - 40_000).toISOString();
  const up2 = await applyBatch(store, exec, { mutations: [{ id: "m-2", at: t2, op: "task.update", sid: appSid, fields: { title: "Newer" } }] }, "p");
  const callsBefore = calls.length;
  const up1 = await applyBatch(store, exec, { mutations: [{ id: "m-3", at: t1, op: "task.update", sid: appSid, fields: { title: "Older" } }] }, "p");
  const supersededWithoutGraph = calls.length === callsBefore;

  // A failed mutation blocks later ones for the same entity in the batch, and
  // can be retried (its row is abandoned, not stored).
  failNext = { error: "graph_unavailable", retry: true };
  const blocked = await applyBatch(store, exec, {
    mutations: [
      { id: "m-4", at: new Date().toISOString(), op: "task.update", sid: appSid, fields: { title: "A" } },
      { id: "m-5", at: new Date().toISOString(), op: "task.update", sid: appSid, fields: { title: "B" } },
    ],
  }, "p");
  const retried = await applyBatch(store, exec, { mutations: [{ id: "m-4", at: new Date().toISOString(), op: "task.update", sid: appSid, fields: { title: "A" } }] }, "p");

  // Delete wins.
  await applyBatch(store, exec, { mutations: [{ id: "m-6", at: new Date().toISOString(), op: "task.delete", sid: appSid }] }, "p");
  const afterDelete = await applyBatch(store, exec, { mutations: [{ id: "m-7", at: new Date().toISOString(), op: "task.update", sid: appSid, fields: { title: "late" } }] }, "p");

  // Validation.
  const bad = await applyBatch(store, exec, {
    mutations: [
      { id: "m-8", at: "nope", op: "task.update", sid: appSid, fields: {} },
      { id: "m-9", at: t0, op: "task.explode", sid: appSid },
      { id: "m-10", at: t0, op: "task.update", sid: appSid, fields: { owner: "x" } },
      { id: "m-11", at: t0, op: "task.update", sid: "ffffffffffffffffffffffffffffffff", fields: { title: "x" } },
      { id: "m-12", at: t0, op: "task.create", sid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", fields: { list_id: "dddddddddddddddddddddddddddddddd", title: "x" } },
      { id: "m-13", at: t0, op: "task.reorder", sid: appSid, position: { top: false } },
      { id: "m-14", at: t0, op: "task.reorder", sid: appSid, position: { before: appSid, after: appSid } },
      { id: "m-15", at: t0, op: "task.reorder", sid: appSid, position: { before: "not-a-sid" } },
      { id: "m-16", at: t0, op: "task.create", sid: "cccccccccccccccccccccccccccccccc", fields: { list_id: listSid, title: "x", owner: "y" } },
      { id: "m-17", at: t0, op: "myday.add", sid: appSid, fields: { title: "x" } },
    ],
  }, "p");

  // Leased: a second request for the same id while the first runs.
  const lease1 = c.mutationBegin("m-lease", "p", 1_000, 60_000);
  const lease2 = c.mutationBegin("m-lease", "p", 2_000, 60_000);
  const lease3 = c.mutationBegin("m-lease", "p", 70_000, 60_000);
  // Released as ambiguous: the next attempt runs at once and learns when the
  // first one began.
  c.mutationRelease("m-lease");
  const lease4 = c.mutationBegin("m-lease", "p", 71_000, 60_000);

  const st = (r: { results: Array<{ status: string }> }) => r.results.map((x) => x.status).join(",");
  const err = (r: { results: Array<Record<string, unknown>> }) => r.results.map((x) => x.error ?? x.status).join(",");
  return {
    "create applies under the app's sid": st(r1) === "applied" && created?.data.title === "Call Acme" && created.data.list_id === listSid,
    "the minted sid is replaced, not kept beside it": sidOf(c, "task", "G1") === appSid.toLowerCase(),
    "a retried create is a duplicate, and Graph is called once": st(retry) === "duplicate" && calls.filter((x) => x.op === "task.create").length === 1,
    "a newer update applies": st(up2) === "applied",
    "an older queued field is superseded without a Graph call":
      st(up1) === "applied" && JSON.stringify((up1.results[0] as { superseded_fields?: string[] }).superseded_fields) === '["title"]' && supersededWithoutGraph,
    "a failure skips the entity's later mutations": st(blocked) === "failed,skipped",
    "a failed mutation can be retried": st(retried) === "applied",
    "an edit to a deleted task is rejected": err(afterDelete) === "deleted",
    "malformed mutations are rejected one by one": err(bad) === "bad_at,unknown_op,unknown_fields:owner,unknown_sid,unknown_list,bad_position,bad_position,bad_position,unknown_fields:owner,unknown_fields:title",
    "a running mutation is leased; an expired lease is taken over":
      lease1.state === "new" && lease2.state === "leased" && lease3.state === "new",
    "the batch returns the current cursor": r1.cursor.includes("."),
    "a create stamps its fields' clocks, not its parent's": "title" in createClocks && !("list_id" in createClocks),
    "a released attempt is re-run at once, with its first start":
      lease4.state === "new" && "prior_at_ms" in lease4 && lease4.prior_at_ms === 1_000,
  };
}
