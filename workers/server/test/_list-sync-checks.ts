// Shared list sync-setting checks (docs/SYNC-API.md section 1.2), run on both
// hosts' SQLite through IndexCore. The env needs a TODO_CACHE KV, where
// updateListsConfig writes config:lists. Returns named facts so each host's test asserts them one by one.
import type { IndexCore } from "@potem/core/index/index-core";
import type { FeedChange, FeedPage } from "@potem/core/index/change-feed";
import type { AppEnv } from "@potem/core/ports";
import { applyBatch, type ExecInput } from "@potem/core/sync/mutations";
import { storeOf } from "./_mutation-checks";

const task = (id: string, title: string) =>
  ({ id, title, status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" }) as never;

function walk(c: IndexCore, cursor: string | null) {
  const all: FeedChange[] = [];
  let remaining = 0;
  for (let i = 0; i < 50; i++) {
    const r = c.syncChanges({ cursor, scope: "all" });
    if (!r.ok) throw new Error(r.error);
    const p: FeedPage = r.page;
    all.push(...p.changes);
    remaining = p.backfill.remaining;
    cursor = p.cursor;
    if (!p.has_more) break;
  }
  return { all, cursor: cursor!, remaining };
}

export async function runListSyncChecks(c: IndexCore, env: AppEnv) {
  c.upsertList({ id: "LT", displayName: "Todo list" } as never);
  c.upsertList({ id: "LR", displayName: "Reference list" } as never);
  c.upsertList({ id: "LX", displayName: "Soon excluded" } as never);
  c.upsertTask(task("TX", "in the excluded list"), "LX");
  await c.updateListsConfig({ overrides: { LR: "reference" } });
  const first = { changed: c.listLists().filter((l) => l.sync).length };
  const full = walk(c, null);
  const sidOf = (graphId: string) => full.all.find((x) => x.kind === "list" && !x.deleted && x.data.name === graphId)?.id;
  const lists = Object.fromEntries(
    full.all.filter((x) => x.kind === "list" && !x.deleted).map((x) => [x.kind === "list" && !x.deleted ? x.data.name : "", x]),
  );
  const txSid = c.syncTaskSids(["TX"]).TX;
  // A completed task in a reference list is never scanned for sub-resources,
  // so it must not count as backfill still to do; an open one does.
  const remaining = () => walk(c, null).remaining;
  const before = remaining();
  c.upsertTask({ ...(task("TRC", "done, in a reference list") as object), status: "completed" } as never, "LR");
  const withCompleted = remaining();
  c.upsertTask(task("TRO", "open, in a reference list"), "LR");
  const withOpen = remaining();
  const lxSid = sidOf("Soon excluded");

  // Exclude LX: its list and task leave the feed as deletion records.
  const exclCfg = await c.updateListsConfig({ overrides: { LX: "excluded" } });
  const inc = walk(c, full.cursor);
  const fullAfter = walk(c, null);
  const route = c.excludedLists();
  const again = await c.refreshListSync(exclCfg);

  // Writes into the excluded list. The index keeps none of them (the Graph
  // write a tool made still stands), and the sync API refuses them.
  c.upsertTask(task("TNEW", "created by a tool"), "LX");
  c.upsertChecklistItem("TNEW", "LX", { id: "S1", displayName: "step" } as never);
  c.upsertTask(task("TM", "moved by a tool"), "LT");
  const tmSid = c.syncTaskSids(["TM"]).TM;
  c.moveTask("TM", "LX");
  const writes = {
    rows: c.query({ lists: ["LX"] }).rows.length + c.getChecklistItems("TNEW").length,
    moved: c.query({ lists: ["LT", "LX"] }).rows.every((r) => r.task_id !== "TM"),
  };
  const execCalls: ExecInput[] = [];
  const at = new Date().toISOString();
  const batch = await applyBatch(
    storeOf(c),
    async (input) => (execCalls.push(input), { ok: true, graphId: input.graphId ?? "new" }),
    {
      mutations: [
        { id: "m1", at, op: "task.update", sid: txSid, fields: { title: "x" } },
        { id: "m2", at, op: "task.create", sid: "0123456789abcdef0123456789abcdef", fields: { list_id: lxSid, title: "x" } },
        { id: "m3", at, op: "task.move", sid: tmSid, fields: { list_id: lxSid } },
        { id: "m4", at, op: "list.update", sid: lxSid, fields: { name: "Renamed" } },
        // Queued before the exclusion above: the newer setting stands.
        { id: "m5", at: new Date(Date.now() - 60_000).toISOString(), op: "list.update", sid: lxSid, fields: { sync: "todo" } },
      ],
    },
    "p",
  );
  const errors = batch.results.map((r) => (r.status === "rejected" ? r.error : r.status));
  const m5 = batch.results[4];

  // Switch it back on: the list returns under its old sid.
  const backCfg = await c.updateListsConfig({ overrides: { LX: "todo" } });
  const back = walk(c, inc.cursor);
  c.upsertTask(task("TX", "in the excluded list"), "LX"); // the baseline brings the task back
  const sidAfter = c.syncTaskSids(["TX"]).TX;

  return {
    "first refresh records a setting for every list": first.changed === 3,
    "feed lists carry their sync setting":
      (lists["Todo list"] as { data: { sync: string } })?.data.sync === "todo" &&
      (lists["Reference list"] as { data: { sync: string } })?.data.sync === "reference",
    "a pin merges into the existing ones": exclCfg.overrides.LR === "reference" && exclCfg.overrides.LX === "excluded",
    "the written config is in KV": JSON.stringify((await env.TODO_CACHE.get("config:lists", "json") as { overrides: unknown }).overrides) === JSON.stringify(backCfg.overrides),
    "an excluded list and its tasks leave the feed as deletion records":
      inc.all.some((x) => x.kind === "list" && x.deleted && x.id === lxSid) &&
      inc.all.some((x) => x.kind === "task" && x.deleted && x.id === txSid),
    "a full sync leaves an excluded list out": !fullAfter.all.some((x) => x.kind === "list" && x.id === lxSid),
    "the excluded list keeps its roster row": c.getList("LX") !== null,
    "the excluded route names it by sid": route.length === 1 && route[0].id === lxSid && route[0].name === "Soon excluded",
    "backfill doesn't count a reference list's completed tasks": withCompleted === before && withOpen === before + 1,
    "an unchanged config writes nothing": again.changed === 0,
    "a write-through into an excluded list keeps no row": writes.rows === 0,
    "a task moved into an excluded list leaves the mirror": writes.moved,
    "the sync API refuses task writes that touch an excluded list":
      errors.slice(0, 3).every((e) => e === "list_excluded"),
    "a setting change from any path is stamped on the field clock":
      Math.abs((c.fieldClocks("list", lxSid!).sync ?? 0) - Date.now()) < 5_000,
    "an app edit older than that change loses to it":
      m5.status === "applied" && JSON.stringify(m5.superseded_fields) === '["sync"]',
    "an excluded list itself can still be updated": errors[3] === "applied" && execCalls.map((x) => x.op).join() === "list.update",
    "a re-included list comes back under its old sid":
      back.all.some((x) => x.kind === "list" && !x.deleted && x.id === lxSid && x.data.sync === "todo"),
    "its tasks keep their sids": !!txSid && sidAfter === txSid,
    "nothing is excluded after re-including": c.excludedLists().length === 0,
  };
}
