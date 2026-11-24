// Shared change-feed assertions (docs/SYNC-API.md section 4), run on both
// hosts' SQLite through IndexCore. Returns named facts so each host's test can
// assert them one by one.
import type { IndexCore } from "../src/core/index/index-core";
import type { FeedChange, FeedPage } from "../src/core/index/change-feed";

const DAY = 86_400_000;
const task = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ id, title, status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z", ...extra }) as never;
const completedAt = (ms: number) => ({
  status: "completed",
  completedDateTime: { dateTime: new Date(ms).toISOString().replace("Z", "0000"), timeZone: "UTC" },
});

function page(c: IndexCore, opts: Parameters<IndexCore["syncChanges"]>[0]): FeedPage {
  const r = c.syncChanges(opts);
  if (!r.ok) throw new Error(`unexpected ${r.error}`);
  return r.page;
}
function walk(c: IndexCore, cursor: string | null, scope: string, limit = 500) {
  const all: FeedChange[] = [];
  let pages = 0;
  for (;;) {
    const p = page(c, { cursor, scope, limit });
    all.push(...p.changes);
    cursor = p.cursor;
    pages++;
    if (!p.has_more || pages > 50) return { all, cursor, pages };
  }
}

export async function runChangeFeedChecks(c: IndexCore) {
  const now = Date.now();
  c.upsertList({ id: "L1", displayName: "One" } as never);
  c.upsertList({ id: "L2", displayName: "Two", wellknownListName: "defaultList" } as never);
  c.upsertTask(
    task("T1", "open", {
      body: { contentType: "html", content: "<p>hi</p>" },
      dueDateTime: { dateTime: "2026-11-25T05:00:00.0000000", timeZone: "UTC" },
      categories: ["Red"],
      isReminderOn: true,
      reminderDateTime: { dateTime: "2026-11-25T14:00:00.0000000", timeZone: "UTC" },
    }),
    "L1",
  );
  c.upsertTask(task("T2", "done recently", completedAt(now - 5 * DAY)), "L1");
  c.upsertTask(task("T3", "done long ago", completedAt(now - 40 * DAY)), "L2");
  c.replaceChecklistItems("T1", "L1", [{ id: "S1", displayName: "step one", isChecked: false } as never]);
  c.replaceLinkedResources("T1", "L1", [{ id: "K1", webUrl: "https://example.com", displayName: "ex" } as never]);
  // A deleted task before the first sync: a full sync must not send its record.
  c.upsertTask(task("T9", "gone"), "L1");
  c.deleteTask("T9");

  const full = walk(c, null, "all");
  const ids = (cs: FeedChange[]) => cs.map((x) => `${x.kind}:${x.deleted ? "-" : "+"}`).sort();
  const t1 = full.all.find((x) => x.kind === "task" && !x.deleted && x.data.title === "open");
  const l1 = full.all.find((x) => x.kind === "list" && !x.deleted && x.data.name === "One");
  const t1d = t1 && !t1.deleted && t1.kind === "task" ? t1.data : null;

  const paged = walk(c, null, "all", 1);
  const active = walk(c, null, "active");

  // Incremental: one edit and one delete after the full sync's cursor.
  c.upsertTask(task("T2", "done recently, renamed", { ...completedAt(now - 5 * DAY), lastModifiedDateTime: "2026-11-24T11:00:00Z" }), "L1");
  c.deleteTask("T1");
  const inc = walk(c, full.cursor, "all");
  // Caught up: the same cursor again returns nothing.
  const again = page(c, { cursor: inc.cursor, scope: "all" });

  const [epoch, seq] = inc.cursor.split(".");
  const otherEpoch = c.syncChanges({ cursor: `${epoch === "abc" ? "abd" : "abc"}.${seq}` });
  const ahead = c.syncChanges({ cursor: `${epoch}.${Number(seq) + 100}` });
  const garbage = c.syncChanges({ cursor: "not-a-cursor" });
  const badScope = c.syncChanges({ scope: "everything" });

  const t2sid = c.syncTaskSids(["T2"]).T2;
  const one = t2sid ? c.syncTask(t2sid) : null;
  const info1 = await c.syncInfo();
  const info2 = await c.syncInfo();

  return {
    "full sync sends two lists and three live tasks, no deletion records":
      JSON.stringify(ids(full.all)) === JSON.stringify(["list:+", "list:+", "task:+", "task:+", "task:+"]),
    "full sync ends caught up with an epoch.seq cursor": /^[0-9a-f]+\.\d+$/.test(full.cursor),
    // Pages after the first carry a cursor, so they may include deletion
    // records for entities the client never had; it ignores those.
    "paging one at a time returns the same live entities":
      JSON.stringify(ids(paged.all.filter((x) => !x.deleted))) === JSON.stringify(ids(full.all)) && paged.pages >= 5,
    "task references its list by sid": !!t1d && !!l1 && t1d.list_id === l1.id,
    "due goes out as a bare date": t1d?.due === "2026-11-25",
    "reminder is an instant": t1d?.reminder.on === true && t1d.reminder.at === "2026-11-25T14:00:00.000Z",
    "body keeps its type": t1d?.body?.type === "html" && t1d.body.content === "<p>hi</p>",
    "categories parsed": JSON.stringify(t1d?.categories) === '["Red"]',
    "steps embedded with sids": t1d?.steps.length === 1 && t1d.steps[0].title === "step one" && /^[0-9a-f]{32}$/.test(t1d.steps[0].id),
    "links embedded with sids": t1d?.links.length === 1 && t1d.links[0].url === "https://example.com",
    "subresources_complete after a scan": t1d?.subresources_complete === true,
    "active scope drops a task completed 40 days ago": !active.all.some((x) => !x.deleted && x.kind === "task" && x.data.title === "done long ago"),
    "active scope keeps a task completed 5 days ago": active.all.some((x) => !x.deleted && x.kind === "task" && x.data.title === "done recently"),
    "active scope cursor reaches the top of the log": active.cursor === full.cursor,
    "incremental sends the edit and the deletion":
      JSON.stringify(ids(inc.all)) === JSON.stringify(["task:+", "task:-"]) &&
      inc.all.some((x) => x.kind === "task" && !x.deleted && x.data.title === "done recently, renamed"),
    "deletion record names the deleted task's sid": inc.all.some((x) => x.deleted && x.id === t1?.id),
    "caught-up cursor returns nothing": again.changes.length === 0 && !again.has_more && again.cursor === inc.cursor,
    "another epoch is a cursor reset": !otherEpoch.ok && otherEpoch.error === "cursor_reset",
    "a cursor ahead of the log is a cursor reset": !ahead.ok && ahead.error === "cursor_reset",
    "a malformed cursor is refused": !garbage.ok && garbage.error === "bad_cursor",
    "an unknown scope is refused": !badScope.ok && badScope.error === "bad_scope",
    "a task is readable by sid": one?.data.title === "done recently, renamed" && one.id === t2sid,
    "server_id is created once": /^[0-9a-f-]{36}$/.test(info1.server_id) && info1.server_id === info2.server_id,
  };
}
