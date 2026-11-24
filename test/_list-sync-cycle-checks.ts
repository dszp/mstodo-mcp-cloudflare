// List sync-setting checks that run a sync cycle against a scripted Graph
// (docs/SYNC-API.md section 1.2), shared by both hosts. The env needs a
// TODO_CACHE KV and MS_CLIENT_SECRET (tokens are sealed). Each check gets its
// own lists, so they share one IndexCore. Returns named facts.
import { vi } from "vitest";
import type { IndexCore } from "../src/core/index/index-core";
import { SCOPES, storeTokens } from "../src/core/auth/microsoft";
import { storeListsConfig } from "../src/core/config/loader";
import { ListsConfigSchema } from "../src/core/config/schemas";
import type { AppEnv } from "../src/core/ports";

const LISTS = "https://graph.microsoft.com/v1.0/me/todo/lists/delta";
const tasksDelta = (id: string) => `https://graph.microsoft.com/v1.0/me/todo/lists/${id}/tasks/delta`;
const task = (id: string) => ({ id, title: id, status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" });
const page = (value: unknown[], deltaLink: string) =>
  new Response(JSON.stringify({ value, "@odata.deltaLink": deltaLink }), { status: 200, headers: { "content-type": "application/json" } });

// Graph as a roster plus each list's tasks. `onTasks` runs when a list's task
// delta is requested, before the response: the place to land a concurrent
// change. Delta links point back at the same handlers.
function stubGraph(roster: string[], tasks: Record<string, string[]>, onTasks: (listId: string) => Promise<void> = async () => {}) {
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (input instanceof Request ? input.url : String(input)).split("?")[0];
      if (url === LISTS || url === `${LISTS}/next`) {
        return page(roster.map((id) => ({ id, displayName: id })), `${LISTS}/next`);
      }
      for (const id of Object.keys(tasks)) {
        if (url === tasksDelta(id) || url === `${tasksDelta(id)}/next`) {
          fetched.push(id);
          await onTasks(id);
          return page(tasks[id].map(task), `${tasksDelta(id)}/next`);
        }
      }
      return new Response("unscripted", { status: 404 });
    }),
  );
  return fetched;
}

export async function runListSyncCycleChecks(c: IndexCore, env: AppEnv, getAlarm: () => Promise<number | null>) {
  await storeTokens(env, { access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000, scope: SCOPES, obtained_at: Date.now() });
  const rows = (listId: string) => c.query({ lists: [listId] }).rows.map((r) => r.task_id);
  const syncOf = (listId: string) => c.getList(listId)?.sync ?? null;
  try {
    // 1. A list excluded while the cycle waits on its task pages.
    stubGraph(["RACE"], { RACE: ["T-RACE"] }, async (id) => {
      if (id === "RACE") await c.updateListsConfig({ overrides: { RACE: "excluded" } });
    });
    await c.alarm();
    const raced = { rows: rows("RACE"), synced: c.isListSynced("RACE"), alarm: await getAlarm() };

    // 2. A list excluded while the cycle works on another one isn't fetched.
    const fetched = stubGraph(["RACE", "NEXT1", "NEXT2"], { NEXT1: [], NEXT2: [] }, async (id) => {
      await c.updateListsConfig({ overrides: { [id === "NEXT1" ? "NEXT2" : "NEXT1"]: "excluded" } });
    });
    await c.runSyncCycle();

    // 3. KV still serves the old value (excluded) after a change to todo was
    //    handed to the index: the next cycle keeps todo and baselines the list.
    await c.updateListsConfig({ overrides: { STALE: "excluded" } });
    const staleKv = ListsConfigSchema.parse({ overrides: { RACE: "excluded", STALE: "excluded" } });
    await c.refreshListSync({ ...staleKv, overrides: { ...staleKv.overrides, STALE: "todo" } });
    await storeListsConfig(env, staleKv);
    stubGraph(["RACE", "STALE"], { RACE: ["T-RACE"], STALE: ["T-STALE"] });
    await c.runSyncCycle();
    const stale = { sync: syncOf("STALE"), rows: rows("STALE") };

    return {
      "a list excluded mid-cycle keeps no task rows": raced.rows.length === 0,
      "a list excluded mid-cycle keeps no sync state": raced.synced === false,
      "a list excluded mid-cycle is not fetched later in it": fetched.length === 1,
      "a setting changed mid-cycle re-arms the alarm at once": raced.alarm !== null && raced.alarm - Date.now() < 1_000,
      "a stale KV read doesn't flip a newer setting back": stale.sync === "todo",
      "the re-included list is baselined in that cycle": stale.rows.join() === "T-STALE",
    };
  } finally {
    vi.unstubAllGlobals();
  }
}
