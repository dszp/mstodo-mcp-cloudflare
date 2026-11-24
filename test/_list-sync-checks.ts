// Shared list sync-setting checks (docs/SYNC-API.md section 1.2), run on both
// hosts' SQLite through IndexCore. The env needs a TODO_CACHE KV, where
// updateListsConfig writes config:lists. Returns named facts so each host's test asserts them one by one.
import type { IndexCore } from "../src/core/index/index-core";
import type { FeedChange, FeedPage } from "../src/core/index/change-feed";
import type { AppEnv } from "../src/core/ports";

const task = (id: string, title: string) =>
  ({ id, title, status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" }) as never;

function walk(c: IndexCore, cursor: string | null) {
  const all: FeedChange[] = [];
  for (let i = 0; i < 50; i++) {
    const r = c.syncChanges({ cursor, scope: "all" });
    if (!r.ok) throw new Error(r.error);
    const p: FeedPage = r.page;
    all.push(...p.changes);
    cursor = p.cursor;
    if (!p.has_more) break;
  }
  return { all, cursor: cursor! };
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
  const lxSid = sidOf("Soon excluded");

  // Exclude LX: its list and task leave the feed as deletion records.
  const exclCfg = await c.updateListsConfig({ overrides: { LX: "excluded" } });
  const inc = walk(c, full.cursor);
  const fullAfter = walk(c, null);
  const route = c.excludedLists();
  const again = await c.refreshListSync(exclCfg);

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
    "an unchanged config writes nothing": again.changed === 0,
    "a re-included list comes back under its old sid":
      back.all.some((x) => x.kind === "list" && !x.deleted && x.id === lxSid && x.data.sync === "todo"),
    "its tasks keep their sids": !!txSid && sidAfter === txSid,
    "nothing is excluded after re-including": c.excludedLists().length === 0,
  };
}
