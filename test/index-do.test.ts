import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { TodoTask, TodoTaskList } from "../src/graph/types";
import type { TodoIndex } from "../src/cache/index-do";
import { OWNER_DO_NAME } from "../src/cache/sql";
import {
  TOKENS_KEY,
  IDENTITY_KEY,
  SCOPES,
  wipeIdentityScopedState,
} from "../src/auth/microsoft";

function indexStub(name = OWNER_DO_NAME) {
  return env.TODO_INDEX_DO.getByName(name);
}

async function seedFreshTokens() {
  await env.TODO_CACHE.put(
    TOKENS_KEY,
    JSON.stringify({
      access_token: "at-fresh",
      refresh_token: "rt",
      expires_at: Date.now() + 3_600_000,
      scope: SCOPES,
      obtained_at: Date.now(),
    }),
  );
}

// Replace global fetch with a router over scripted Graph pages keyed by URL.
// followToTerminal/GraphClient call fetch(url); an unscripted URL returns 404
// so a mis-scripted test fails loudly rather than hanging on the network.
function stubGraph(
  pages: Record<
    string,
    { status?: number; body?: unknown; headers?: Record<string, string> }
  >,
) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    const e = pages[url];
    if (!e) return new Response(`unscripted: ${url}`, { status: 404 });
    return new Response(e.body === undefined ? "" : JSON.stringify(e.body), {
      status: e.status ?? 200,
      headers: { "content-type": "application/json", ...(e.headers ?? {}) },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const syncTask = (id: string, title = `t-${id}`) => ({
  id,
  title,
  status: "notStarted",
  lastModifiedDateTime: "2026-05-02T00:00:00Z",
});
const syncRemoved = (id: string) => ({ id, "@removed": { reason: "deleted" } });

const taskFixture: TodoTask = {
  id: "task-1",
  title: "Buy invoice paper",
  status: "notStarted",
  importance: "high",
  body: { content: "<p>Need 5&amp;more reams</p>", contentType: "html" },
  createdDateTime: "2026-05-01T10:00:00Z",
  lastModifiedDateTime: "2026-05-02T11:00:00Z",
  dueDateTime: { dateTime: "2026-06-01T00:00:00.0000000", timeZone: "UTC" },
  isReminderOn: false,
  hasAttachments: false,
};

const listFixture: TodoTaskList = {
  id: "list-A",
  displayName: "Work",
  isOwner: true,
  isShared: false,
};

describe("TodoIndex CRUD + FTS", () => {
  it("upserts a task and maps Graph fields into the row", async () => {
    const stub = indexStub("crud-1");
    await stub.upsertTask(taskFixture, "list-A");

    const { rows } = await stub.query({ lists: ["list-A"] });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.task_id).toBe("task-1");
    expect(r.list_id).toBe("list-A");
    expect(r.status).toBe("notStarted");
    expect(r.title).toBe("Buy invoice paper");
    expect(r.importance).toBe("high");
    expect(r.body_plain).toBe("Need 5&more reams");
    expect(r.due_at).toBe(Date.parse("2026-06-01T00:00:00Z"));
    expect(r.modified_at).toBe(Date.parse("2026-05-02T11:00:00Z"));
    expect(r.has_attachments).toBe(0);
  });

  it("upsert is idempotent on task_id (no duplicate rows)", async () => {
    const stub = indexStub("crud-2");
    await stub.upsertTask(taskFixture, "list-A");
    await stub.upsertTask({ ...taskFixture, title: "Renamed" }, "list-A");

    const { rows } = await stub.query({ lists: ["list-A"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Renamed");
  });

  it("deleteTask removes the row and its FTS entry", async () => {
    const stub = indexStub("crud-3");
    await stub.upsertTask(taskFixture, "list-A");
    expect((await stub.search({ query: "invoice" })).rows).toHaveLength(1);

    await stub.deleteTask("task-1");

    expect((await stub.query({ lists: ["list-A"] })).rows).toHaveLength(0);
    expect((await stub.search({ query: "invoice" })).rows).toHaveLength(0);
  });

  it("setTaskFlags bumps has_checklist/has_attachments; no-op on unknown task", async () => {
    const stub = indexStub("crud-flags");
    await stub.upsertTask(taskFixture, "list-A"); // checklistItems absent → NULL
    await stub.setTaskFlags("task-1", { has_checklist: true });
    expect((await stub.query({ lists: ["list-A"] })).rows[0].has_checklist).toBe(1);

    // Unknown task id: silently no-ops (a later sync fills the row in).
    await stub.setTaskFlags("ghost", { has_attachments: true });
    expect((await stub.query({ lists: ["list-A"] })).rows).toHaveLength(1);
  });

  it("findListForTask returns the list id + display name, null when unknown", async () => {
    const stub = indexStub("crud-4");
    await stub.upsertList(listFixture);
    await stub.upsertTask(taskFixture, "list-A");

    expect(await stub.findListForTask("task-1")).toEqual({
      list_id: "list-A",
      display_name: "Work",
    });
    expect(await stub.findListForTask("nope")).toBeNull();
  });
});

describe("TodoIndex resetIdentity", () => {
  const LISTS_DELTA = "https://graph.microsoft.com/v1.0/me/todo/lists/delta";
  const TASKS_DELTA_A =
    "https://graph.microsoft.com/v1.0/me/todo/lists/list-A/tasks/delta";
  const LISTS_DL = "https://graph.microsoft.com/v1.0/me/todo/lists/delta?dl=1";
  const TASKS_DL_A = "https://graph.microsoft.com/v1.0/me/todo/lists/list-A/tasks/delta?dl=1";
  const listA = { id: "list-A", displayName: "Work" };

  afterEach(() => vi.unstubAllGlobals());

  it("wipes tasks, roster, sync_state and cancels the pending alarm", async () => {
    await seedFreshTokens();
    stubGraph({
      [LISTS_DELTA]: { body: { value: [listA], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DELTA_A]: {
        body: { value: [syncTask("a"), syncTask("b")], "@odata.deltaLink": TASKS_DL_A },
      },
    });
    const stub = indexStub("reset-identity");
    await stub.runSyncCycle(); // baseline → roster + tasks + sync_state rows

    // Sanity: state is populated before the reset.
    expect((await stub.query({ lists: ["list-A"] })).rows).toHaveLength(2);
    expect(await stub.listLists()).toHaveLength(1);
    expect((await stub.syncStatus()).totals).toEqual({
      tasks: 2,
      lists: 1,
      all_idle: true,
    });

    // Arm an alarm, reset, and read the alarm back in one DO context so the
    // assertion can't race a stray firing.
    const alarmAfter = await runInDurableObject(stub, async (inst: TodoIndex, state) => {
      await inst.ensureSyncing();
      await inst.resetIdentity();
      return state.storage.getAlarm();
    });

    expect(alarmAfter).toBeNull();
    expect((await stub.query({ lists: ["list-A"] })).rows).toHaveLength(0);
    expect((await stub.search({ query: "a" })).rows).toHaveLength(0);
    expect(await stub.listLists()).toHaveLength(0);
    // Fresh-index shape: no sync_state ⇒ the "lists" resource reads
    // baseline_pending, so all_idle is false until the next baseline runs.
    expect((await stub.syncStatus()).totals).toEqual({
      tasks: 0,
      lists: 0,
      all_idle: false,
    });
  });
});

describe("TodoIndex token refresh", () => {
  it("coalesces concurrent refreshes into one upstream call (single-flight)", async () => {
    await env.TODO_CACHE.put(
      TOKENS_KEY,
      JSON.stringify({
        access_token: "old-at",
        refresh_token: "rt-1",
        expires_at: Date.now() - 1000, // expired → forces a refresh
        scope: SCOPES,
        obtained_at: Date.now() - 3_600_000,
      }),
    );

    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token_type: "Bearer",
            scope: SCOPES,
            expires_in: 3600,
            access_token: "new-at",
            refresh_token: "rt-2",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const stub = indexStub("token-1");
      const [a, b] = await Promise.all([
        stub.getAccessToken(),
        stub.getAccessToken(),
      ]);
      expect(a).toBe("new-at");
      expect(b).toBe("new-at");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("TodoIndex substrate (My Day) token mint", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function seedTokens(opts: { graphExpired?: boolean; refreshToken?: string } = {}) {
    await env.TODO_CACHE.put(
      TOKENS_KEY,
      JSON.stringify({
        access_token: "graph-at",
        refresh_token: opts.refreshToken ?? "rt-1",
        expires_at: opts.graphExpired ? Date.now() - 1000 : Date.now() + 3_600_000,
        scope: SCOPES,
        obtained_at: Date.now(),
      }),
    );
  }

  // Token endpoint that routes by the requested `scope`: an Exchange Online
  // (outlook.office.com) scope yields an EXO-audience access token; anything
  // else yields a Graph token. Each call rotates the refresh token.
  function stubTokenEndpoint() {
    let n = 0;
    return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const isExo = (body.get("scope") ?? "").includes("outlook.office.com");
      n += 1;
      return new Response(
        JSON.stringify({
          token_type: "Bearer",
          scope: body.get("scope"),
          expires_in: 3600,
          access_token: isExo ? "exo-at" : "graph-at-new",
          refresh_token: `rt-${n + 1}`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  }

  it("mints an EXO token, caches it in memory, and preserves the graph token", async () => {
    await seedTokens();
    const spy = stubTokenEndpoint();
    vi.stubGlobal("fetch", spy);
    const stub = indexStub("sub-mint");

    expect(await stub.getSubstrateAccessToken()).toBe("exo-at");
    // Second call is served from the in-memory cache — no second /token.
    expect(await stub.getSubstrateAccessToken()).toBe("exo-at");
    expect(spy).toHaveBeenCalledTimes(1);

    // The substrate mint persists ONLY the rotated refresh token; the Graph
    // access token in tokens:owner is untouched (a Graph caller still reads it).
    const stored = JSON.parse((await env.TODO_CACHE.get(TOKENS_KEY))!);
    expect(stored.access_token).toBe("graph-at");
    expect(stored.refresh_token).toBe("rt-2");
  });

  it("serializes a concurrent graph refresh + substrate mint (no refresh-token race)", async () => {
    await seedTokens({ graphExpired: true });
    const spy = stubTokenEndpoint();
    vi.stubGlobal("fetch", spy);
    const stub = indexStub("sub-concurrent");

    const [graphTok, exoTok] = await Promise.all([
      stub.getAccessToken(), // expired → graph refresh
      stub.getSubstrateAccessToken(), // EXO mint
    ]);
    expect(graphTok).toBe("graph-at-new");
    expect(exoTok).toBe("exo-at");
    // Two distinct /token calls, serialized on the shared chain.
    expect(spy).toHaveBeenCalledTimes(2);

    // Graph's full record persisted; substrate didn't clobber the access token.
    const stored = JSON.parse((await env.TODO_CACHE.get(TOKENS_KEY))!);
    expect(stored.access_token).toBe("graph-at-new");
  });

  it("latches my_day_unavailable on AADSTS65001 and stops minting", async () => {
    await seedTokens();
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "AADSTS65001: The user has not consented...",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", spy);
    const stub = indexStub("sub-noconsent");

    // Assert the rejections IN-CONTEXT (not over the RPC stub): a rejecting DO
    // method awaited across the stub boundary leaves the promise unobserved on
    // the DO side, which workerd reports as an unhandled rejection (fails the
    // run). Same reason the H4 generation-guard test uses runInDurableObject.
    await runInDurableObject(stub, async (inst: TodoIndex) => {
      await expect(inst.getSubstrateAccessToken()).rejects.toThrow("my_day_unavailable");
      // Latched in memory — the next call short-circuits without another /token.
      await expect(inst.getSubstrateAccessToken()).rejects.toThrow("my_day_unavailable");
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("TodoIndex delta sync", () => {
  const LISTS_DELTA = "https://graph.microsoft.com/v1.0/me/todo/lists/delta";
  const TASKS_DELTA_A =
    "https://graph.microsoft.com/v1.0/me/todo/lists/list-A/tasks/delta";
  // Continuation links must use the real Graph host: GraphClient pins it
  // (assertGraphUrl) so the owner Bearer token can't leak to a foreign host.
  const LISTS_DL = "https://graph.microsoft.com/v1.0/me/todo/lists/delta?dl=1";
  const TASKS_DL_A =
    "https://graph.microsoft.com/v1.0/me/todo/lists/list-A/tasks/delta?dl=1";
  const TASKS_DL_A2 =
    "https://graph.microsoft.com/v1.0/me/todo/lists/list-A/tasks/delta?dl=2";
  const TASKS_P2 =
    "https://graph.microsoft.com/v1.0/me/todo/lists/list-A/tasks/delta?page=2";
  const listA = { id: "list-A", displayName: "Work" };

  afterEach(() => vi.unstubAllGlobals());

  it("baseline: follows nextLink→deltaLink and stores all task rows", async () => {
    await seedFreshTokens();
    stubGraph({
      [LISTS_DELTA]: { body: { value: [listA], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DELTA_A]: {
        body: { value: [syncTask("a")], "@odata.nextLink": TASKS_P2 },
      },
      [TASKS_P2]: {
        body: { value: [syncTask("b")], "@odata.deltaLink": TASKS_DL_A },
      },
    });

    const stub = indexStub("sync-baseline");
    const midCycle = await stub.runSyncCycle();

    expect(midCycle).toBe(false);
    const { rows } = await stub.query({ lists: ["list-A"] });
    expect(rows.map((r) => r.task_id).sort()).toEqual(["a", "b"]);
  });

  it("incremental: resumes from the stored deltaLink, applying upsert + @removed", async () => {
    await seedFreshTokens();
    stubGraph({
      [LISTS_DELTA]: { body: { value: [listA], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DELTA_A]: {
        body: {
          value: [syncTask("a"), syncTask("b")],
          "@odata.deltaLink": TASKS_DL_A,
        },
      },
    });
    const stub = indexStub("sync-incr");
    await stub.runSyncCycle(); // baseline → a, b

    // Incremental page (reached only by resuming from the stored deltaLinks —
    // baseline URLs are intentionally absent here, so a re-baseline bug 404s).
    stubGraph({
      [LISTS_DL]: { body: { value: [], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DL_A]: {
        body: {
          value: [{ ...syncTask("a"), title: "A-updated" }, syncRemoved("b")],
          "@odata.deltaLink": TASKS_DL_A2,
        },
      },
    });
    const midCycle = await stub.runSyncCycle();

    expect(midCycle).toBe(false);
    const { rows } = await stub.query({ lists: ["list-A"] });
    expect(rows.map((r) => r.task_id)).toEqual(["a"]);
    expect(rows[0].title).toBe("A-updated");
  });

  it("resumable: a task budget of 1 stops mid-baseline, then completes", async () => {
    await seedFreshTokens();
    stubGraph({
      [LISTS_DELTA]: { body: { value: [listA], "@odata.deltaLink": LISTS_DL } },
      [LISTS_DL]: { body: { value: [], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DELTA_A]: {
        body: { value: [syncTask("a")], "@odata.nextLink": TASKS_P2 },
      },
      [TASKS_P2]: {
        body: { value: [syncTask("b")], "@odata.deltaLink": TASKS_DL_A },
      },
    });
    const stub = indexStub("sync-resume");

    const mid1 = await stub.runSyncCycle(1);
    expect(mid1).toBe(true);
    expect((await stub.query({ lists: ["list-A"] })).rows.map((r) => r.task_id)).toEqual([
      "a",
    ]);

    const mid2 = await stub.runSyncCycle(1);
    expect(mid2).toBe(false);
    expect(
      (await stub.query({ lists: ["list-A"] })).rows.map((r) => r.task_id).sort(),
    ).toEqual(["a", "b"]);
  });

  it("410: purges the list's rows and re-baselines on the next cycle", async () => {
    await seedFreshTokens();
    stubGraph({
      [LISTS_DELTA]: { body: { value: [listA], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DELTA_A]: {
        body: {
          value: [syncTask("a"), syncTask("b")],
          "@odata.deltaLink": TASKS_DL_A,
        },
      },
    });
    const stub = indexStub("sync-410");
    await stub.runSyncCycle(); // baseline → a, b

    // The stored deltaLink now 410s; the baseline collection has changed to [c].
    stubGraph({
      [LISTS_DL]: { body: { value: [], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DL_A]: { status: 410, body: { error: { code: "syncStateNotFound" } } },
      [TASKS_DELTA_A]: {
        body: { value: [syncTask("c")], "@odata.deltaLink": TASKS_DL_A2 },
      },
    });

    const mid1 = await stub.runSyncCycle(); // 410 → purge + reset to baseline
    expect(mid1).toBe(true);
    expect((await stub.query({ lists: ["list-A"] })).rows).toHaveLength(0);

    await stub.runSyncCycle(); // re-baseline → c
    expect((await stub.query({ lists: ["list-A"] })).rows.map((r) => r.task_id)).toEqual([
      "c",
    ]);
  });

  it("429 throttle: preserves rows + cursor, stays mid-cycle, resumes (no error stall)", async () => {
    await seedFreshTokens();
    stubGraph({
      [LISTS_DELTA]: { body: { value: [listA], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DELTA_A]: {
        body: {
          value: [syncTask("a"), syncTask("b")],
          "@odata.deltaLink": TASKS_DL_A,
        },
      },
    });
    const stub = indexStub("sync-429");
    await stub.runSyncCycle(); // baseline → a, b; tasks delta_link = TASKS_DL_A

    // Stored deltaLink throttles (retry-after 0 so the in-request retry is fast,
    // then GraphClient throws GraphError(429)).
    stubGraph({
      [LISTS_DL]: { body: { value: [], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DL_A]: { status: 429, headers: { "retry-after": "0" }, body: {} },
    });
    const mid = await stub.runSyncCycle();

    // Mid-cycle (fast re-arm), rows untouched (not purged like 410), cursor kept.
    expect(mid).toBe(true);
    expect((await stub.query({ lists: ["list-A"] })).rows.map((r) => r.task_id).sort()).toEqual([
      "a",
      "b",
    ]);

    // Throttle clears: same stored deltaLink now serves an incremental page.
    stubGraph({
      [LISTS_DL]: { body: { value: [], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DL_A]: {
        body: { value: [syncRemoved("b")], "@odata.deltaLink": TASKS_DL_A2 },
      },
    });
    await stub.runSyncCycle();
    expect((await stub.query({ lists: ["list-A"] })).rows.map((r) => r.task_id)).toEqual([
      "a",
    ]);
  });

  it("ensureSyncing arms an alarm when none is pending", async () => {
    const stub = indexStub("sync-arm");
    // Arm + read in one DO context so the assertion doesn't race the ~immediate
    // alarm firing (which, with no tokens seeded, would clear it again).
    const armed = await runInDurableObject(stub, async (inst: TodoIndex, state) => {
      await inst.ensureSyncing();
      return state.storage.getAlarm();
    });
    expect(armed).not.toBeNull();
  });
});

describe("TodoIndex syncStatus", () => {
  const LISTS_DELTA = "https://graph.microsoft.com/v1.0/me/todo/lists/delta";
  const TASKS_DELTA_A =
    "https://graph.microsoft.com/v1.0/me/todo/lists/list-A/tasks/delta";
  const LISTS_DL = "https://graph.microsoft.com/v1.0/me/todo/lists/delta?dl=1";
  const TASKS_DL_A = "https://graph.microsoft.com/v1.0/me/todo/lists/list-A/tasks/delta?dl=1";
  const TASKS_P2 = "https://graph.microsoft.com/v1.0/me/todo/lists/list-A/tasks/delta?page=2";
  const listA = { id: "list-A", displayName: "Work" };

  afterEach(() => vi.unstubAllGlobals());

  it("reports idle + row counts + totals after a full baseline", async () => {
    await seedFreshTokens();
    stubGraph({
      [LISTS_DELTA]: { body: { value: [listA], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DELTA_A]: {
        body: {
          value: [syncTask("a"), syncTask("b")],
          "@odata.deltaLink": TASKS_DL_A,
        },
      },
    });
    const stub = indexStub("status-idle");
    await stub.runSyncCycle();

    const s = await stub.syncStatus();
    expect(s.totals).toEqual({ tasks: 2, lists: 1, all_idle: true });

    const roster = s.resources.find((r) => r.resource === "lists");
    expect(roster?.status).toBe("idle");
    expect(roster?.row_count).toBe(1);

    const tasksA = s.resources.find((r) => r.resource === "tasks:list-A");
    expect(tasksA?.status).toBe("idle");
    expect(tasksA?.mid_cycle).toBe(false);
    expect(tasksA?.row_count).toBe(2);
  });

  it("flags mid_cycle and clears all_idle while a baseline is draining", async () => {
    await seedFreshTokens();
    stubGraph({
      [LISTS_DELTA]: { body: { value: [listA], "@odata.deltaLink": LISTS_DL } },
      [LISTS_DL]: { body: { value: [], "@odata.deltaLink": LISTS_DL } },
      [TASKS_DELTA_A]: {
        body: { value: [syncTask("a")], "@odata.nextLink": TASKS_P2 },
      },
      [TASKS_P2]: {
        body: { value: [syncTask("b")], "@odata.deltaLink": TASKS_DL_A },
      },
    });
    const stub = indexStub("status-draining");
    await stub.runSyncCycle(1); // budget 1 → stops mid-baseline, next_link set

    const s = await stub.syncStatus();
    const tasksA = s.resources.find((r) => r.resource === "tasks:list-A");
    expect(tasksA?.mid_cycle).toBe(true);
    expect(s.totals.all_idle).toBe(false);
  });

  it("surfaces a roster list with no task sync_state as baseline_pending", async () => {
    // Roster only: upsert a list directly (no task delta has run for it).
    const stub = indexStub("status-pending");
    await stub.upsertList({ id: "list-Z", displayName: "Untouched" });

    const s = await stub.syncStatus();
    const tasksZ = s.resources.find((r) => r.resource === "tasks:list-Z");
    expect(tasksZ?.status).toBe("baseline_pending");
    expect(tasksZ?.row_count).toBe(0);
    expect(s.totals.all_idle).toBe(false);
  });
});

describe("TodoIndex syncStatus — sync_disabled (Feature B.4)", () => {
  afterEach(async () => {
    await env.TODO_CACHE.delete("config:lists");
  });

  it("reports sync_disabled for a built-in-skipped list", async () => {
    const stub = indexStub("status-disabled-1");
    await stub.upsertList({ id: "list-A", displayName: "Work", isOwner: true, isShared: false });
    await stub.upsertList({
      id: "list-F",
      displayName: "Flagged Emails",
      wellknownListName: "flaggedEmails",
      isOwner: true,
      isShared: false,
    });
    await stub.upsertTask(
      { id: "t1", title: "x", status: "notStarted", lastModifiedDateTime: "2026-05-02T00:00:00Z" },
      "list-A",
    );

    const status = await stub.syncStatus();
    const fRes = status.resources.find((r) => r.resource === "tasks:list-F");
    expect(fRes?.status).toBe("sync_disabled");
    expect(fRes?.row_count).toBe(0);
    expect(fRes?.mid_cycle).toBe(false);
  });
});

describe("TodoIndex #refresh generation guard (H4)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("discards a refresh that resolves after an identity switch (no token clobber)", async () => {
    await env.TODO_CACHE.put(
      TOKENS_KEY,
      JSON.stringify({
        access_token: "at-old",
        refresh_token: "rt-old",
        expires_at: Date.now() + 3_600_000,
        scope: SCOPES,
        obtained_at: Date.now(),
      }),
    );

    // Hold the token-endpoint response until `released` flips. The stub polls a
    // plain closure variable from inside the DO request context (not a Promise
    // shared across contexts — that trips Workers' "I/O on behalf of a different
    // request" guard), so we can switch identity while the refresh is parked.
    let released = false;
    const tokenUrl = `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input);
        if (url !== tokenUrl) return new Response(`unscripted: ${url}`, { status: 404 });
        while (!released) await new Promise((r) => setTimeout(r, 5));
        return new Response(
          JSON.stringify({
            token_type: "Bearer",
            scope: SCOPES,
            expires_in: 3600,
            access_token: "at-new",
            refresh_token: "rt-new",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    // Park → switch → assert all inside one DO context. Calling refreshToken()
    // over the RPC stub instead would leave the rejecting #refresh promise
    // unobserved on the DO side (the stub's await lives across the boundary),
    // which workerd reports as an unhandled rejection. Holding the in-context
    // promise here and awaiting its rejection directly keeps it observed.
    const stub = indexStub("h4-gen");
    await runInDurableObject(stub, async (inst: TodoIndex) => {
      const p = inst.refreshToken(); // parks in the polling token fetch
      await new Promise((r) => setTimeout(r, 20)); // let #refresh snapshot gen + park
      await inst.resetIdentity(); // owner switch bumps the generation
      released = true; // stub returns the (now prior-account) tokens

      await expect(p).rejects.toThrow("identity_changed_during_refresh");
    });

    // The prior-account tokens were NOT written over the (now-wiped) identity.
    const stored = JSON.parse((await env.TODO_CACHE.get(TOKENS_KEY))!);
    expect(stored.access_token).toBe("at-old");
  });
});

describe("wipeIdentityScopedState — Feature A alias clearing", () => {
  afterEach(async () => {
    await env.TODO_CACHE.delete("config:lists");
    await env.TODO_CACHE.delete("config:link_rules");
    await env.TODO_CACHE.delete("config:attachments");
    await env.TODO_CACHE.delete(TOKENS_KEY);
    await env.TODO_CACHE.delete(IDENTITY_KEY);
  });

  it("clears aliases but preserves patterns/no_sync, leaves other config untouched", async () => {
    await env.TODO_CACHE.put(
      "config:lists",
      JSON.stringify({
        patterns: [{ pattern: "work", flags: "i", type: "todo" }],
        aliases: { inbox: "old-account-list-id", finance: "another-old-id" },
        no_sync: ["flaggedEmails"],
        sync_flagged_emails: false,
      }),
    );
    await env.TODO_CACHE.put("config:link_rules", JSON.stringify({ rules: [] }));
    await env.TODO_CACHE.put("config:attachments", JSON.stringify({ max_inline_bytes: 1024 }));
    await env.TODO_CACHE.put(TOKENS_KEY, JSON.stringify({ access_token: "x" }));
    await env.TODO_CACHE.put(IDENTITY_KEY, JSON.stringify({ id: "old" }));

    await wipeIdentityScopedState(env as unknown as Env);

    const cfg = (await env.TODO_CACHE.get("config:lists", "json")) as Record<string, unknown>;
    expect(cfg.aliases).toEqual({});
    expect(cfg.patterns).toEqual([{ pattern: "work", flags: "i", type: "todo" }]);
    expect(cfg.no_sync).toEqual(["flaggedEmails"]);
    expect(await env.TODO_CACHE.get("config:link_rules")).not.toBeNull();
    expect(await env.TODO_CACHE.get("config:attachments")).not.toBeNull();
    expect(await env.TODO_CACHE.get(TOKENS_KEY)).toBeNull();
    expect(await env.TODO_CACHE.get(IDENTITY_KEY)).toBeNull();
  });

  it("is a no-op when config:lists has no aliases", async () => {
    await env.TODO_CACHE.put(
      "config:lists",
      JSON.stringify({ patterns: [], aliases: {} }),
    );
    await expect(wipeIdentityScopedState(env as unknown as Env)).resolves.toBeUndefined();
    const cfg = (await env.TODO_CACHE.get("config:lists", "json")) as Record<string, unknown>;
    expect(cfg.aliases).toEqual({});
  });
});

describe("wipeIdentityScopedState (H3 — fail-closed identity wipe)", () => {
  it("clears KV tokens + identity and the DO index (rows, roster, sync_state)", async () => {
    await env.TODO_CACHE.put(
      TOKENS_KEY,
      JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expires_at: Date.now() + 3_600_000,
        scope: SCOPES,
        obtained_at: Date.now(),
      }),
    );
    await env.TODO_CACHE.put(
      IDENTITY_KEY,
      JSON.stringify({
        id: "old-id",
        displayName: "Old Owner",
        mail: "old@example.com",
        userPrincipalName: "old@example.com",
        first_seen: 1,
        last_seen: 2,
      }),
    );

    // wipeIdentityScopedState targets idFromName(OWNER_DO_NAME) — the default
    // indexStub() instance. Seed it with roster + task state.
    const stub = indexStub();
    await stub.upsertList({
      id: "list-A",
      displayName: "Work",
      isOwner: true,
      isShared: false,
    });
    await stub.upsertTask({ id: "t1", title: "x", status: "notStarted" }, "list-A");
    expect((await stub.query({})).rows.length).toBeGreaterThan(0);

    // The cloudflare:test env carries the wrangler-generated bindings but not
    // the OAuthProvider-injected OAUTH_PROVIDER (added to Env in src/types.ts);
    // wipeIdentityScopedState never touches it, so narrow the type for the call.
    await wipeIdentityScopedState(env as unknown as Env);

    expect(await env.TODO_CACHE.get(TOKENS_KEY)).toBeNull();
    expect(await env.TODO_CACHE.get(IDENTITY_KEY)).toBeNull();
    expect((await stub.query({})).rows.length).toBe(0);
    expect((await stub.listLists()).length).toBe(0);
  });
});

describe("TodoIndex runSyncCycle — no_sync skip + self-heal (Feature B.3)", () => {
  const LISTS_DELTA = "https://graph.microsoft.com/v1.0/me/todo/lists/delta";
  const LISTS_DL = "https://graph.microsoft.com/v1.0/me/todo/lists/delta?dl=1";
  const tasksDelta = (id: string) => `https://graph.microsoft.com/v1.0/me/todo/lists/${id}/tasks/delta`;
  const tasksDL = (id: string) => `https://graph.microsoft.com/v1.0/me/todo/lists/${id}/tasks/delta?dl=1`;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await env.TODO_CACHE.delete("config:lists");
  });

  it("does not index a flaggedEmails list on baseline (built-in skip)", async () => {
    await seedFreshTokens();
    stubGraph({
      [LISTS_DELTA]: {
        body: {
          value: [
            { id: "list-A", displayName: "Work" },
            { id: "list-F", displayName: "Flagged", wellknownListName: "flaggedEmails" },
          ],
          "@odata.deltaLink": LISTS_DL,
        },
      },
      [tasksDelta("list-A")]: {
        body: { value: [syncTask("a")], "@odata.deltaLink": tasksDL("list-A") },
      },
      // list-F tasks delta is intentionally NOT scripted — if the loop tried to
      // sync it, followToTerminal would hit the 404 fallback and error loudly.
    });
    const stub = indexStub("nosync-baseline");
    await stub.runSyncCycle();

    expect((await stub.query({ lists: ["list-A"] })).rows).toHaveLength(1);
    expect((await stub.query({ lists: ["list-F"] })).rows).toHaveLength(0);
    expect(await stub.listLists()).toHaveLength(2); // roster keeps both
    const fRes = (await stub.syncStatus()).resources.find((r) => r.resource === "tasks:list-F");
    expect(fRes?.status).toBe("sync_disabled");
  });

  it("self-heals: purges rows + sync_state when a synced list is added to no_sync", async () => {
    await seedFreshTokens();
    stubGraph({
      [LISTS_DELTA]: { body: { value: [{ id: "list-A", displayName: "Work" }], "@odata.deltaLink": LISTS_DL } },
      [tasksDelta("list-A")]: {
        body: { value: [syncTask("a"), syncTask("b")], "@odata.deltaLink": tasksDL("list-A") },
      },
    });
    const stub = indexStub("nosync-selfheal");
    await stub.runSyncCycle(); // list-A indexed with 2 rows + sync_state
    expect((await stub.query({ lists: ["list-A"] })).rows).toHaveLength(2);

    // Owner adds list-A to no_sync (by id), then a cycle runs.
    await env.TODO_CACHE.put(
      "config:lists",
      JSON.stringify({ patterns: [], aliases: {}, no_sync: ["list-A"] }),
    );
    // Second cycle: roster will hit LISTS_DL (stored deltaLink), needs to be scripted.
    stubGraph({
      [LISTS_DL]: { body: { value: [{ id: "list-A", displayName: "Work" }], "@odata.deltaLink": LISTS_DL } },
    });
    await stub.runSyncCycle();

    expect((await stub.query({ lists: ["list-A"] })).rows).toHaveLength(0); // purged
    expect((await stub.search({ query: "a" })).rows).toHaveLength(0); // FTS cascade
    expect(await stub.listLists()).toHaveLength(1); // roster retained
    const status = await stub.syncStatus();
    const aRes = status.resources.find((r) => r.resource === "tasks:list-A");
    expect(aRes?.status).toBe("sync_disabled");
    expect(status.totals.all_idle).toBe(true); // lists idle, list-A excluded
  });

  it("indexes flaggedEmails when sync_flagged_emails is true (override)", async () => {
    await seedFreshTokens();
    await env.TODO_CACHE.put(
      "config:lists",
      JSON.stringify({ patterns: [], aliases: {}, sync_flagged_emails: true }),
    );
    stubGraph({
      [LISTS_DELTA]: {
        body: {
          value: [{ id: "list-F", displayName: "Flagged", wellknownListName: "flaggedEmails" }],
          "@odata.deltaLink": LISTS_DL,
        },
      },
      [tasksDelta("list-F")]: {
        body: { value: [syncTask("f1")], "@odata.deltaLink": tasksDL("list-F") },
      },
    });
    const stub = indexStub("nosync-override");
    await stub.runSyncCycle();

    expect((await stub.query({ lists: ["list-F"] })).rows).toHaveLength(1);
    const fRes = (await stub.syncStatus()).resources.find((r) => r.resource === "tasks:list-F");
    expect(fRes?.status).toBe("idle");
  });
});
