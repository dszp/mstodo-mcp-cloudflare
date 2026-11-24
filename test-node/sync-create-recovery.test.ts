// Ambiguous-create recovery for lists and links (docs/SYNC-API.md section
// 5.4): a create whose earlier attempt may have reached Graph adopts what that
// attempt made instead of making a second one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpsContext } from "../src/core/ops/context";
import { syncExecutor } from "../src/core/sync/executor";
import type { ExecInput } from "../src/core/sync/mutations";

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
      firstSeenMs: async (_kind: string, ids: string[]) =>
        Object.fromEntries(ids.filter((id) => opts.firstSeen?.[id] !== undefined).map((id) => [id, opts.firstSeen![id]])),
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
