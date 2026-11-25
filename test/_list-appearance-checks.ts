// Sidebar appearance checks (docs/SYNC-API.md section 10.4): list groups,
// sidebar order and theme, read from Substrate and served in the change feed.
// Shared by both hosts; each function returns named facts so each host's test
// asserts them one by one.
import { vi } from "vitest";
import type { IndexCore } from "../src/core/index/index-core";
import type { FeedChange, FeedPage } from "../src/core/index/change-feed";
import type { AppEnv, SqlDb, SqlValue } from "../src/core/ports";
import { SCOPES, storeTokens } from "../src/core/auth/microsoft";
import { ListsConfigSchema } from "../src/core/config/schemas";
import { SCHEMA_DDL } from "../src/core/index/sql";
import { applyMigrations } from "../src/core/index/migrations";

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
const live = (cs: FeedChange[], kind: FeedChange["kind"]) => cs.filter((x) => x.kind === kind && !x.deleted);
const listNamed = (cs: FeedChange[], name: string) =>
  cs.find((x) => x.kind === "list" && !x.deleted && x.data.name === name) as Extract<FeedChange, { kind: "list"; deleted: false }> | undefined;
const groupIn = (cs: FeedChange[]) =>
  cs.find((x) => x.kind === "list_group" && !x.deleted) as Extract<FeedChange, { kind: "list_group"; deleted: false }> | undefined;

// The feed side, driven through applyListAppearance (no network).
export async function runListAppearanceFeedChecks(c: IndexCore) {
  c.upsertList({ id: "A1", displayName: "Tasks", wellknownListName: "defaultList" } as never);
  c.upsertList({ id: "A2", displayName: "Work" } as never);
  c.upsertList({ id: "A3", displayName: "Hidden" } as never);
  await c.refreshListSync(ListsConfigSchema.parse({ overrides: { A3: "excluded" } }));
  const start = walk(c, null);
  const beforeRead = listNamed(start.all, "Work")?.data;

  const ids = ["A1", "A2", "A3"];
  const G1 = { Id: "G1", Name: "Clients", OrderDateTime: "2026-11-21T10:00:00.0000000Z" };
  const first = c.applyListAppearance(
    [
      { Id: "A1", OrderDateTime: null, ThemeColor: "blue", ThemeBackground: "mountain" },
      { Id: "A2", OrderDateTime: "2026-11-20T10:00:00.0000000Z", ParentFolderGroupId: "G1", ThemeColor: { r: 1 }, ThemeBackground: null },
      { Id: "A3", ThemeColor: "red" },
      { Id: "NOT-IN-GRAPH" },
    ],
    [G1],
    ids,
  );
  const inc1 = walk(c, start.cursor);
  const group = groupIn(inc1.all);
  const work = listNamed(inc1.all, "Work");
  const tasks = listNamed(inc1.all, "Tasks");
  const seqOf = (x: FeedChange | undefined) => x?.seq ?? -1;
  const full = walk(c, null);
  const fullGroupIdx = full.all.findIndex((x) => x.kind === "list_group");
  const fullWorkIdx = full.all.findIndex((x) => x.kind === "list" && !x.deleted && x.data.name === "Work");

  // The same read again logs nothing.
  c.applyListAppearance(
    [
      { Id: "A1", OrderDateTime: null, ThemeColor: "blue", ThemeBackground: "mountain" },
      { Id: "A2", OrderDateTime: "2026-11-20T10:00:00.0000000Z", ParentFolderGroupId: "G1", ThemeColor: { r: 1 }, ThemeBackground: null },
      { Id: "A3", ThemeColor: "red" },
    ],
    [G1],
    ids,
  );
  const inc2 = walk(c, inc1.cursor);

  // The default list moves into the group: one list change, nothing else.
  const folders3 = [
    { Id: "A1", OrderDateTime: "2026-11-22T10:00:00.0000000Z", ParentFolderGroupId: "G1", ThemeColor: "blue", ThemeBackground: "mountain" },
    { Id: "A2", OrderDateTime: "2026-11-20T10:00:00.0000000Z", ParentFolderGroupId: "G1", ThemeColor: { r: 1 }, ThemeBackground: null },
    { Id: "A3", ThemeColor: "red" },
  ];
  c.applyListAppearance(folders3, [G1], ids);
  const inc3 = walk(c, inc2.cursor);

  // The group is renamed: one group change, under the same id.
  c.applyListAppearance(folders3, [{ ...G1, Name: "Customers" }], ids);
  const inc4 = walk(c, inc3.cursor);

  // The group is deleted; Substrate then reports its lists ungrouped.
  c.applyListAppearance(
    folders3.map((f) => ({ ...f, ParentFolderGroupId: null })),
    [],
    ids,
  );
  const inc5 = walk(c, inc4.cursor);

  // A list naming a group the read didn't return goes out ungrouped.
  c.applyListAppearance([{ Id: "A2", ParentFolderGroupId: "GX" }], [], ids);
  const inc6 = walk(c, inc5.cursor);
  const orphan = listNamed(inc6.all, "Work");

  // A group whose member list the read doesn't return: deleting the group
  // still logs the list again, ungrouped.
  const G2 = { Id: "G2", Name: "Two", OrderDateTime: null };
  c.applyListAppearance([{ Id: "A2", ParentFolderGroupId: "G2" }], [G2], ids);
  const inc7 = walk(c, inc6.cursor);
  const g2 = groupIn(inc7.all);
  c.applyListAppearance([{ Id: "A1" }], [], ids);
  const inc8 = walk(c, inc7.cursor);

  // The reads disagree (a folder names a group the group read lacks): no
  // stored group is deleted.
  c.applyListAppearance([{ Id: "A2", ParentFolderGroupId: "G3" }], [G2], ids);
  const inc9 = walk(c, inc8.cursor);
  const disagree = c.applyListAppearance([{ Id: "A2", ParentFolderGroupId: "G4" }], [], ids);
  const inc10 = walk(c, inc9.cursor);

  return {
    "lists carry null appearance before the first read":
      beforeRead?.group_id === null && beforeRead.sort_key === null &&
      beforeRead.theme.color === null && beforeRead.theme.background === null,
    "the read reports a folder Graph doesn't have": first.unmatched_folders === 1 && first.lists === 3,
    "a group arrives as a list_group change": group?.data.name === "Clients" && group.data.sort_key === G1.OrderDateTime,
    "a grouped list names the group's sid": !!group && work?.data.group_id === group.id,
    "sort_key is the order as Substrate sends it": work?.data.sort_key === "2026-11-20T10:00:00.0000000Z",
    "the default list's sort_key is null": tasks?.data.sort_key === null && tasks.data.group_id === null,
    "theme strings pass through unchanged": tasks?.data.theme.color === "blue" && tasks.data.theme.background === "mountain",
    "a non-string theme is stored as its JSON": work?.data.theme.color === '{"r":1}' && work.data.theme.background === null,
    "the group is logged before the lists the read moved into it": seqOf(group) < seqOf(work),
    "a full sync sends the group before its list": fullGroupIdx >= 0 && fullGroupIdx < fullWorkIdx,
    "an excluded list stores its appearance but stays out of the feed":
      c.getList("A3")?.theme_color === "red" && !full.all.some((x) => x.kind === "list" && !x.deleted && x.data.name === "Hidden"),
    "an unchanged read logs nothing": inc2.all.length === 0,
    "moving a list into a group logs only that list":
      inc3.all.length === 1 && listNamed(inc3.all, "Tasks")?.data.group_id === group?.id,
    "renaming a group logs only the group, same id":
      inc4.all.length === 1 && groupIn(inc4.all)?.data.name === "Customers" && groupIn(inc4.all)?.id === group?.id,
    "deleting a group sends its deletion record":
      inc5.all.some((x) => x.kind === "list_group" && x.deleted && x.id === group?.id),
    "deleting a group ungroups its lists":
      live(inc5.all, "list").length === 2 &&
      live(inc5.all, "list").every((x) => x.kind === "list" && !x.deleted && x.data.group_id === null),
    "a list naming an unknown group goes out ungrouped": orphan?.data.group_id === null,
    "a deleted group's member is logged ungrouped even when the read omits it":
      !!g2 && inc8.all.some((x) => x.kind === "list_group" && x.deleted && x.id === g2.id) &&
      listNamed(inc8.all, "Work")?.data.group_id === null,
    "when the reads disagree, no stored group is deleted":
      disagree.groups_kept_unconfirmed && disagree.groups_deleted === 0 &&
      !inc10.all.some((x) => x.kind === "list_group" && x.deleted),
  };
}

const SUB = "https://substrate.office.com/todob2/api/v1";
const LISTS = "https://graph.microsoft.com/v1.0/me/todo/lists/delta";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface FakeMicrosoft {
  roster: string[];
  folders: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
  // Set to answer the folder read with this status instead.
  folderStatus?: number;
  // Set to refuse the Exchange Online token (AADSTS65001).
  refuseExo?: boolean;
  // Runs when the folders are requested, before the answer.
  onFolders?: () => Promise<void>;
  // Every Substrate request as "METHOD /path", without the query.
  substrate: string[];
  // The query of each folder read.
  folderQueries?: string[];
}

// Graph (roster + empty task lists), the token endpoint and Substrate.
function stubMicrosoft(m: FakeMicrosoft) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const full = input instanceof Request ? input.url : String(input);
      const url = full.split("?")[0];
      if (url === LISTS || url === `${LISTS}/next`) {
        return json({ value: m.roster.map((id) => ({ id, displayName: id })), "@odata.deltaLink": `${LISTS}/next` });
      }
      if (url.startsWith("https://graph.microsoft.com/v1.0/me/todo/lists/") && url.includes("/tasks/delta")) {
        return json({ value: [], "@odata.deltaLink": `${url.replace(/\/next$/, "")}/next` });
      }
      if (url.includes("login.microsoftonline.com")) {
        return m.refuseExo
          ? json({ error: "invalid_grant", error_description: "AADSTS65001: The user has not consented." }, 400)
          : json({ access_token: "EXO", expires_in: 3600, token_type: "Bearer", scope: "x" });
      }
      if (url.startsWith(SUB)) {
        const path = url.slice(SUB.length);
        m.substrate.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/taskfolders") (m.folderQueries ??= []).push(decodeURIComponent(full.split("?")[1] ?? ""));
        if (path === "/taskfolders") {
          await m.onFolders?.();
          if (m.folderStatus === 429) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
          return m.folderStatus ? json({ error: "x" }, m.folderStatus) : json({ value: m.folders });
        }
        if (path === "/foldergroups") return json({ value: m.groups, "@odata.deltaLink": `${SUB}/foldergroups?delta=1` });
        if (/^\/taskfolders\/[^/]+\/tasks$/.test(path)) return json({ value: [] });
      }
      return new Response("unscripted", { status: 404 });
    }),
  );
}

async function signIn(env: AppEnv) {
  await storeTokens(env, { access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000, scope: SCOPES, obtained_at: Date.now() });
}

const reads = (m: FakeMicrosoft) => m.substrate.filter((p) => p === "GET /taskfolders" || p === "GET /foldergroups").length;

// The sync cycle side: when the read runs, and that a failing or refused
// Substrate never fails the cycle. Needs ENABLE_MY_DAY=true and the MS_*
// values for a token refresh. `sql` is the same database, to age the last read.
// `state` is the index's StateStore, to end a backoff early.
export async function runListAppearanceCycleChecks(
  c: IndexCore,
  env: AppEnv,
  sql: SqlDb,
  state: { put(key: string, value: unknown): Promise<void>; get<T>(key: string): Promise<T | undefined> },
) {
  await signIn(env);
  const m: FakeMicrosoft = {
    roster: ["C1", "C2"],
    folders: [
      { Id: "C1", OrderDateTime: "2026-11-01T00:00:00Z", ThemeColor: "green", ThemeBackground: "beach" },
      { Id: "C2", OrderDateTime: "2026-11-02T00:00:00Z", ParentFolderGroupId: "GG" },
    ],
    groups: [{ Id: "GG", Name: "Group", OrderDateTime: "2026-11-03T00:00:00Z" }],
    substrate: [],
  };
  const age = () =>
    sql.exec("UPDATE sync_state SET last_synced_at = last_synced_at - 16 * 60000 WHERE resource = 'meta:appearance'");
  try {
    stubMicrosoft(m);
    await c.runSyncCycle();
    const afterFirst = reads(m);
    const firstRow = c.getList("C1");
    const info = await c.syncInfo();

    await c.runSyncCycle();
    const afterSecond = reads(m);

    m.roster = ["C1", "C2", "C3"];
    m.folders = [...m.folders, { Id: "C3", ThemeColor: "purple" }];
    await c.runSyncCycle();
    const afterNewList = reads(m);

    age();
    await c.runSyncCycle();
    const afterInterval = reads(m);

    // A failed read keeps the stored appearance and backs off.
    age();
    m.folderStatus = 500;
    let failedCycleThrew = false;
    await c.runSyncCycle().catch(() => (failedCycleThrew = true));
    const afterFailure = reads(m);
    const keptRow = c.getList("C1");
    const errState = sql.exec<{ status: string | null }>("SELECT status FROM sync_state WHERE resource = 'meta:appearance'").toArray()[0];
    const backoff1 = await state.get<{ failures: number; next_at: number }>("appearance:backoff");
    age();
    await c.runSyncCycle();
    const duringBackoff = reads(m);
    // A second failure doubles the wait.
    const endBackoff = async () => {
      const b = await state.get<{ failures: number; next_at: number }>("appearance:backoff");
      if (b) await state.put("appearance:backoff", { ...b, next_at: 0 });
    };
    await endBackoff();
    await c.runSyncCycle();
    const backoff2 = await state.get<{ failures: number; next_at: number }>("appearance:backoff");
    // A 429 is not retried in the cycle: one request, then back off.
    await endBackoff();
    m.folderStatus = 429;
    const before429 = reads(m);
    const t429 = Date.now();
    await c.runSyncCycle();
    const ms429 = Date.now() - t429;
    const after429 = reads(m);
    // Success clears the backoff.
    await endBackoff();
    m.folderStatus = undefined;
    await c.runSyncCycle();
    const afterRetry = reads(m);
    const backoffCleared = (await state.get("appearance:backoff")) == null;

    // A 403 turns off list appearance only: My Day keeps working.
    age();
    m.folderStatus = 403;
    let deniedCycleThrew = false;
    await c.runSyncCycle().catch(() => (deniedCycleThrew = true));
    age();
    const beforeDenied = reads(m);
    // Make every list's My Day scan due, to see the scan still runs.
    sql.exec("UPDATE sync_state SET last_synced_at = 0 WHERE resource LIKE 'myday:%'");
    const myDayCallsBefore = m.substrate.filter((p) => /^GET \/taskfolders\/.+\/tasks$/.test(p)).length;
    await c.runSyncCycle();
    const myDayCallsAfter = m.substrate.filter((p) => /^GET \/taskfolders\/.+\/tasks$/.test(p)).length;
    const infoDenied = await c.syncInfo();
    const exoToken = await c.getSubstrateAccessToken().catch((e) => String(e));

    return {
      "the first calm cycle reads folders and groups once": afterFirst === 2,
      "the read stores order, group and theme on the row":
        firstRow?.theme_color === "green" && firstRow.theme_background === "beach" && firstRow.order_datetime === "2026-11-01T00:00:00Z",
      "a grouped list stores the group's Substrate id": c.getList("C2")?.group_id === "GG",
      "the folder read asks for only the fields it uses":
        m.folderQueries?.[0] === "$select=Id,OrderDateTime,ParentFolderGroupId,ThemeColor,ThemeBackground",
      "every Substrate call is a GET": m.substrate.every((p) => p.startsWith("GET ")),
      "list_appearance is on while Substrate works": info.capabilities.list_appearance === true,
      "list_appearance_write is on while Substrate works": info.capabilities.list_appearance_write === true,
      "the next cycle within the interval doesn't read again": afterSecond === afterFirst,
      "a new list makes the next cycle read": afterNewList === afterSecond + 2 && c.getList("C3")?.theme_color === "purple",
      "a read a sync interval old is repeated": afterInterval === afterNewList + 2,
      "a failed read doesn't fail the cycle": !failedCycleThrew && afterFailure === afterInterval + 1,
      "a failed read keeps the stored appearance": keptRow?.theme_color === "green",
      "a failed read is recorded": errState?.status === "error",
      "a failed read backs off one sync interval":
        backoff1?.failures === 1 && Math.abs(backoff1.next_at - Date.now() - 15 * 60_000) < 60_000,
      "no read is made during the backoff, even when the interval has passed": duringBackoff === afterFailure,
      "a second failure doubles the backoff":
        backoff2?.failures === 2 && backoff2.next_at - Date.now() > 29 * 60_000 && backoff2.next_at - Date.now() <= 30 * 60_000,
      "a 429 is not retried within the cycle": after429 === before429 + 1 && ms429 < 900,
      "a successful read clears the backoff": afterRetry === after429 + 2 && backoffCleared,
      "a 403 doesn't fail the cycle": !deniedCycleThrew,
      "after a 403 the sidebar isn't read again": reads(m) === beforeDenied,
      "after a 403 list_appearance is off": infoDenied.capabilities.list_appearance === false,
      "after a 403 list_appearance_write is off": infoDenied.capabilities.list_appearance_write === false,
      "a 403 on the sidebar leaves My Day on": exoToken === "EXO" && myDayCallsAfter > myDayCallsBefore,
    };
  } finally {
    vi.unstubAllGlobals();
  }
}

// The Exchange Online scope is refused (AADSTS65001): the cycle succeeds, no
// Substrate call is made, and the lists keep null appearance.
export async function runListAppearanceRefusedChecks(c: IndexCore, env: AppEnv) {
  await signIn(env);
  const m: FakeMicrosoft = { roster: ["R1"], folders: [{ Id: "R1", ThemeColor: "x" }], groups: [], refuseExo: true, substrate: [] };
  try {
    stubMicrosoft(m);
    let threw = false;
    await c.runSyncCycle().catch(() => (threw = true));
    await c.runSyncCycle().catch(() => (threw = true));
    const row = c.getList("R1");
    const feed = listNamed(walk(c, null).all, "R1");
    const info = await c.syncInfo();
    return {
      "the cycle succeeds": !threw && !!row,
      "no Substrate call is made": m.substrate.length === 0,
      "the appearance columns stay null": row?.theme_color == null && row?.order_datetime == null && row?.group_id == null,
      "the feed sends null appearance": feed?.data.theme.color === null && feed.data.sort_key === null && feed.data.group_id === null,
      "list_appearance is off": info.capabilities.list_appearance === false,
      "list_appearance_write is off": info.capabilities.list_appearance_write === false,
    };
  } finally {
    vi.unstubAllGlobals();
  }
}

// Migration v12 on a database at v11 that already holds a list. A Durable
// Object's database is already migrated when the test gets it, so v12 is
// taken back off first.
export function runListAppearanceMigrationChecks(sql: SqlDb) {
  sql.exec(SCHEMA_DDL);
  applyMigrations(sql, 11);
  if (sql.exec<{ version: number }>("SELECT version FROM schema_meta").one().version > 11) {
    for (const e of ["ai", "au", "ad"]) sql.exec(`DROP TRIGGER list_groups_sync_${e}`);
    sql.exec("DROP TABLE list_groups");
    sql.exec("DROP TRIGGER lists_sync_au");
    for (const col of ["group_id", "order_datetime", "theme_color", "theme_background", "appearance_synced_at"]) {
      sql.exec(`ALTER TABLE lists DROP COLUMN ${col}`);
    }
    sql.exec("UPDATE schema_meta SET version = 11");
  }
  sql.exec("INSERT INTO lists (list_id, display_name, sync) VALUES ('M1', 'kept', 'todo')");
  const top = () => sql.exec<{ s: number | null }>("SELECT max(seq) s FROM sync_log").one().s ?? 0;
  const before = top();
  const { applied } = applyMigrations(sql);
  const cols = sql.exec<{ name: string }>("PRAGMA table_info(lists)").toArray().map((c) => c.name);
  const row = sql.exec<Record<string, SqlValue>>("SELECT * FROM lists WHERE list_id = 'M1'").toArray()[0];
  const afterMigration = top();
  sql.exec("UPDATE lists SET appearance_synced_at = 1 WHERE list_id = 'M1'");
  const afterMarker = top();
  sql.exec("UPDATE lists SET theme_color = 'blue' WHERE list_id = 'M1'");
  const afterTheme = top();
  sql.exec("INSERT INTO list_groups (group_id, name) VALUES ('MG', 'g')");
  const groupLog = sql
    .exec<{ deleted: number }>("SELECT l.deleted FROM sync_log l JOIN entity_map m ON m.kind = l.kind AND m.sid = l.sid WHERE m.graph_id = 'MG'")
    .toArray();
  sql.exec("DELETE FROM list_groups WHERE group_id = 'MG'");
  const groupGone = sql
    .exec<{ deleted: number }>("SELECT l.deleted FROM sync_log l JOIN entity_map m ON m.kind = l.kind AND m.sid = l.sid WHERE m.graph_id = 'MG'")
    .toArray();
  return {
    "v12 runs on a v11 database": applied.join() === "12",
    "lists gain the appearance columns":
      ["group_id", "order_datetime", "theme_color", "theme_background", "appearance_synced_at"].every((c) => cols.includes(c)),
    "existing lists keep their data, appearance null": row?.display_name === "kept" && row.theme_color === null && row.appearance_synced_at === null,
    "the migration logs nothing": afterMigration === before,
    "the read marker logs nothing": afterMarker === afterMigration,
    "a theme change logs the list": afterTheme > afterMarker,
    "a new group gets a sid and a change": groupLog.length === 1 && groupLog[0].deleted === 0,
    "a deleted group leaves a deletion record": groupGone.length === 1 && groupGone[0].deleted === 1,
  };
}

// The owner changes (resetIdentity) while the sidebar read is in flight:
// nothing from the read is written.
export async function runListAppearanceIdentityChecks(c: IndexCore, env: AppEnv, sql: SqlDb) {
  await signIn(env);
  const m: FakeMicrosoft = {
    roster: ["I1"],
    folders: [{ Id: "I1", ThemeColor: "x", ParentFolderGroupId: "IG" }],
    groups: [{ Id: "IG", Name: "g" }],
    substrate: [],
  };
  try {
    stubMicrosoft(m);
    m.onFolders = async () => {
      m.onFolders = undefined;
      await c.resetIdentity();
      // The new owner's roster arrives before the old read finishes.
      sql.exec("INSERT INTO lists (list_id, display_name) VALUES ('I1', 'new owner')");
    };
    let threw = false;
    await c.runSyncCycle().catch(() => (threw = true));
    const groups = sql.exec<{ n: number }>("SELECT count(*) n FROM list_groups").one().n;
    const row = c.getList("I1");
    return {
      "the cycle succeeds": !threw,
      "no group from the old owner's read is stored": groups === 0,
      "no list gets the old owner's appearance": row?.theme_color == null && row?.appearance_synced_at == null,
    };
  } finally {
    vi.unstubAllGlobals();
  }
}

// A write stores sidebar values while a read is in flight: the read may
// predate the write, so nothing from it is applied, and the next cycle reads
// again. `sql` is the same database, to inspect the mirror.
export async function runListAppearanceSupersededChecks(c: IndexCore, env: AppEnv, sql: SqlDb) {
  await signIn(env);
  const m: FakeMicrosoft = {
    roster: ["W1"],
    folders: [{ Id: "W1", ThemeColor: "blue", OrderDateTime: "2026-11-01T00:00:00Z" }],
    groups: [],
    substrate: [],
  };
  try {
    stubMicrosoft(m);
    m.onFolders = async () => {
      m.onFolders = undefined;
      // The list must exist for the write's UPDATE to land.
      sql.exec("INSERT OR IGNORE INTO lists (list_id, display_name) VALUES ('W1', 'W1')");
      c.storeFolderGroup({ Id: "WG", Name: "new", OrderDateTime: "2026-11-05T00:00:00.123Z" });
      c.storeFolderAppearance({ Id: "W1", ThemeColor: "dark_red", OrderDateTime: "2026-11-01T00:00:00Z", ParentFolderGroupId: "WG" });
    };
    await c.runSyncCycle();
    const afterRace = c.getList("W1");
    const firstReadAfterDrop = await c.sidebarFirstReadAt();
    const groupKept = sql.exec<{ n: number }>("SELECT count(*) n FROM list_groups WHERE group_id = 'WG'").one().n === 1;
    const readsBefore = reads(m);
    m.folders = [{ Id: "W1", ThemeColor: "dark_red", OrderDateTime: "2026-11-01T00:00:00Z", ParentFolderGroupId: "WG" }];
    m.groups = [{ Id: "WG", Name: "new", OrderDateTime: "2026-11-05T00:00:00.123Z" }];
    await c.runSyncCycle();
    const afterNext = c.getList("W1");
    const firstRead = await c.sidebarFirstReadAt();
    await c.resetIdentity();
    const afterReset = await c.sidebarFirstReadAt();
    return {
      "the dropped read doesn't count as the first read": firstReadAfterDrop === null,
      "the next read counts as the first": firstRead !== null,
      "an owner switch forgets the first read": afterReset === null,
      "the write's theme survives the stale read": afterRace?.theme_color === "dark_red",
      "the write's group survives the stale read": groupKept && afterRace?.group_id === "WG",
      "the next cycle reads again and marks the list read": reads(m) > readsBefore && afterNext?.appearance_synced_at != null,
    };
  } finally {
    vi.unstubAllGlobals();
  }
}
