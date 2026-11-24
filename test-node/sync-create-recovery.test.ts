// Ambiguous-create recovery for lists and links (docs/SYNC-API.md section
// 5.4): a create whose earlier attempt may have reached Graph adopts what that
// attempt made instead of making a second one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GraphError } from "../src/core/graph/client";
import { IndexCore } from "../src/core/index/index-core";
import type { OpsContext } from "../src/core/ops/context";
import { syncExecutor } from "../src/core/sync/executor";
import { applyBatch, type ExecInput } from "../src/core/sync/mutations";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { storeOf } from "../test/_mutation-checks";

const S = "0190a1b2c3d47e5f8a9b0000000000ff";
const ATTEMPT = Date.parse("2026-11-24T12:00:00Z");

function fakeCtx(opts: { lists?: Array<{ id: string; displayName: string }>; firstSeen?: Record<string, number>; links?: unknown[] }) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const reserved: unknown[][] = [];
  const ctx = {
    env: { TIMEZONE: "UTC" },
    graph: {
      getAllPages: async () => ({ status: 200, items: opts.lists ?? [] }),
      getJson: async () => ({ id: "T1", title: "t", status: "notStarted", linkedResources: opts.links ?? [] }),
      postJson: async (url: string, body: Record<string, unknown>) => {
        posts.push({ url, body });
        return url.endsWith("/linkedResources") ? { id: "K-new", ...body } : { id: "L-new", ...body };
      },
    },
    index: {
      createCandidates: async (_kind: string, ids: string[]) =>
        Object.fromEntries(
          ids.filter((id) => opts.firstSeen?.[id] !== undefined).map((id) => [id, { first_seen_ms: opts.firstSeen![id], app_owned: false }]),
        ),
      reserveSid: async (...a: unknown[]) => {
        reserved.push(a);
        return true;
      },
      upsertList: async () => {},
      upsertLinkedResource: async () => {},
      findListForTask: async () => ({ list_id: "L1" }),
    },
    writes: { run: (fn: () => Promise<unknown>) => fn() },
  } as unknown as OpsContext;
  return { ctx, posts, reserved };
}

const listCreate = (prior?: number): ExecInput => ({
  op: "list.create",
  sid: S,
  graphId: null,
  fields: { name: "Groceries" },
  ids: {},
  ...(prior !== undefined ? { priorAttemptMs: prior } : {}),
});
const linkCreate = (prior?: number): ExecInput => ({
  op: "link.create",
  sid: S,
  graphId: null,
  fields: { task_id: "tsid", url: "https://example.com" },
  ids: { tsid: "T1" },
  ...(prior !== undefined ? { priorAttemptMs: prior } : {}),
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("list.create retry after an ambiguous failure", () => {
  it("adopts a same-name list the mirror hasn't seen yet, without creating", async () => {
    const { ctx, posts, reserved } = fakeCtx({ lists: [{ id: "L-made", displayName: "Groceries" }] });
    expect(await syncExecutor(ctx)(listCreate(ATTEMPT))).toEqual({ ok: true, graphId: "L-made" });
    expect(["no second create", posts.length]).toEqual(["no second create", 0]);
    expect(["app sid reserved", reserved]).toEqual(["app sid reserved", [["list", S, "L-made"]]]);
  });

  it("adopts a same-name list first seen after the attempt began", async () => {
    const { ctx, posts } = fakeCtx({
      lists: [{ id: "L-old", displayName: "Groceries" }, { id: "L-made", displayName: "Groceries" }],
      firstSeen: { "L-old": ATTEMPT - 86_400_000, "L-made": ATTEMPT + 3_000 },
    });
    expect(await syncExecutor(ctx)(listCreate(ATTEMPT))).toEqual({ ok: true, graphId: "L-made" });
    expect(["no second create", posts.length]).toEqual(["no second create", 0]);
  });

  it("creates when the only same-name list predates the attempt", async () => {
    const { ctx, posts } = fakeCtx({ lists: [{ id: "L-old", displayName: "Groceries" }], firstSeen: { "L-old": ATTEMPT - 86_400_000 } });
    expect(await syncExecutor(ctx)(listCreate(ATTEMPT))).toEqual({ ok: true, graphId: "L-new" });
    expect(["created once", posts.length]).toEqual(["created once", 1]);
  });

  it("refuses when two candidates could be the earlier attempt's", async () => {
    const { ctx, posts } = fakeCtx({ lists: [{ id: "A", displayName: "Groceries" }, { id: "B", displayName: "Groceries" }] });
    expect(await syncExecutor(ctx)(listCreate(ATTEMPT))).toEqual({ ok: false, error: "ambiguous_create", retry: false, rejected: true });
    expect(["nothing created", posts.length]).toEqual(["nothing created", 0]);
  });

  it("a first attempt doesn't look", async () => {
    const { ctx, posts } = fakeCtx({ lists: [{ id: "L-made", displayName: "Groceries" }] });
    expect(await syncExecutor(ctx)(listCreate())).toEqual({ ok: true, graphId: "L-new" });
    expect(["created", posts.length]).toEqual(["created", 1]);
  });
});

describe("link.create carries its sid as the externalId", () => {
  it("a new link is created with externalId = sid", async () => {
    const { ctx, posts } = fakeCtx({});
    expect(await syncExecutor(ctx)(linkCreate())).toEqual({ ok: true, graphId: "K-new" });
    expect(["externalId", posts[0]?.body.externalId]).toEqual(["externalId", S]);
  });

  it("a retry adopts the link whose externalId is the sid, without creating", async () => {
    const { ctx, posts, reserved } = fakeCtx({
      links: [
        { id: "K-other", applicationName: "x", externalId: "someone-else" },
        { id: "K-made", applicationName: "x", externalId: S },
      ],
    });
    expect(await syncExecutor(ctx)(linkCreate(ATTEMPT))).toEqual({ ok: true, graphId: "K-made" });
    expect(["no second create", posts.length]).toEqual(["no second create", 0]);
    expect(["app sid reserved", reserved]).toEqual(["app sid reserved", [["link", S, "K-made"]]]);
  });

  it("a retry with no matching link creates one", async () => {
    const { ctx, posts } = fakeCtx({ links: [{ id: "K-other", applicationName: "x", externalId: "someone-else" }] });
    expect(await syncExecutor(ctx)(linkCreate(ATTEMPT))).toEqual({ ok: true, graphId: "K-new" });
    expect(["created once", posts.length]).toEqual(["created once", 1]);
  });
});

// The same, on a real index: what the recovery may and may not adopt.
function realCore() {
  const db = openDatabase(":memory:");
  const state = stateStore(db);
  const c = new IndexCore({ sql: sqlDb(db), transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  c.upsertList({ id: "L1", displayName: "One" } as never);
  return c;
}
const pull = (c: IndexCore, cursor: string | null) => {
  const r = c.syncChanges({ cursor });
  if (!r.ok) throw new Error(r.error);
  return r.page;
};

describe("recovery never takes another mutation's entity", () => {
  const S1 = "0190aaaa-0000-7000-8000-000000000001";
  const S2 = "0190aaaa-0000-7000-8000-000000000002";

  it("two same-name list creates, the second failing before Graph: both lists exist, each under its own sid", async () => {
    const c = realCore();
    const graphLists: Array<{ id: string; displayName: string }> = [{ id: "L1", displayName: "One" }];
    let posts = 0;
    let failNext = false;
    const ctx = {
      env: { TIMEZONE: "UTC" },
      graph: {
        getAllPages: async () => ({ status: 200, items: graphLists }),
        postJson: async (_u: string, body: { displayName: string }) => {
          posts++;
          if (failNext) {
            failNext = false;
            throw new GraphError(503, "service unavailable"); // didn't commit
          }
          const l = { id: `G${posts}`, displayName: body.displayName };
          graphLists.push(l);
          return l;
        },
      },
      index: c,
      writes: { run: (fn: () => Promise<unknown>) => fn() },
    } as unknown as OpsContext;
    const exec = syncExecutor(ctx);
    const store = storeOf(c);
    const at = new Date().toISOString();
    const m1 = { id: "m1", at, op: "list.create", sid: S1, fields: { name: "Untitled list" } };
    const m2 = { id: "m2", at, op: "list.create", sid: S2, fields: { name: "Untitled list" } };
    await applyBatch(store, exec, { mutations: [m1] }, "p");
    failNext = true;
    await applyBatch(store, exec, { mutations: [m2] }, "p");
    const retry = await applyBatch(store, exec, { mutations: [m2] }, "p");
    expect(["retry applied", retry.results[0].status]).toEqual(["retry applied", "applied"]);
    expect(["two lists in Graph", graphLists.filter((l) => l.displayName === "Untitled list").length]).toEqual(["two lists in Graph", 2]);
    const sids = c.resolveSids([{ kind: "list", sid: S1 }, { kind: "list", sid: S2 }]);
    expect(["S1 still live", sids[`list:${S1}`]]).toEqual(["S1 still live", { graph_id: "G1", live: true }]);
    expect(["S2 on the new list", sids[`list:${S2}`]]).toEqual(["S2 on the new list", { graph_id: "G3", live: true }]);
  });

  it("adoptSid refuses to retire a sid the app chose", () => {
    const c = realCore();
    expect(c.reserveSid("list", S1, "G1")).toBe(true);
    c.upsertList({ id: "G1", displayName: "x" } as never);
    expect(["second sid refused", c.adoptSid("list", S2, "G1")]).toEqual(["second sid refused", false]);
    expect(c.resolveSids([{ kind: "list", sid: S1 }])[`list:${S1}`]).toEqual({ graph_id: "G1", live: true });
  });
});

describe("subresources_complete reaches clients", () => {
  it("the first fetch of a task's sub-resources is logged even when has_checklist doesn't change", () => {
    const c = realCore();
    c.upsertTask({ id: "T", title: "t", status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" } as never, "L1");
    const item = { id: "S1", displayName: "step", isChecked: false, createdDateTime: "2026-11-24T10:00:01Z" };
    c.upsertChecklistItem("T", "L1", item as never); // has_checklist = 1, marker still NULL
    const p = pull(c, null);
    const before = p.changes.find((x) => x.kind === "task") as unknown as { data: { subresources_complete: boolean } };
    expect(["before the scan", before.data.subresources_complete]).toEqual(["before the scan", false]);
    c.replaceChecklistItems("T", "L1", [item] as never);
    const after = pull(c, p.cursor).changes.find((x) => x.kind === "task") as unknown as { data: { subresources_complete: boolean } } | undefined;
    expect(["after the scan", after?.data.subresources_complete]).toEqual(["after the scan", true]);
  });

  it("a delta copy without checklistItems keeps has_checklist and isn't re-sent", () => {
    const c = realCore();
    const T = { id: "T", title: "t", status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" };
    c.upsertTask(T as never, "L1");
    c.replaceChecklistItems("T", "L1", []);
    const p = pull(c, null);
    c.upsertTask(T as never, "L1"); // the delta echo
    expect(["echo logs nothing", pull(c, p.cursor).changes.length]).toEqual(["echo logs nothing", 0]);
  });

  it("a copy-move's re-keyed steps report not-fetched until the scan", () => {
    const c = realCore();
    c.upsertTask({ id: "T", title: "t", status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" } as never, "L1");
    c.replaceChecklistItems("T", "L1", []);
    const p = pull(c, null);
    c.forgetSubresources("T");
    const t = pull(c, p.cursor).changes.find((x) => x.kind === "task") as unknown as { data: { subresources_complete: boolean } } | undefined;
    expect(["after forget", t?.data.subresources_complete]).toEqual(["after forget", false]);
  });
});
