// core/api/router.ts against a fake IndexBackend: the mapping from index
// results to HTTP, including cases a real index can't produce yet
// (cursor_expired: retention isn't built).
import { describe, it, expect, vi } from "vitest";
import { emailHint, ftsTerms, handleApiRequest, handlePublicApiRequest } from "../src/core/api/router";
import type { AppEnv } from "../src/core/ports";
import type { Props } from "../src/core/types";

const EPOCH = "e1";
const PROPS: Partial<Props> = { epoch: EPOCH, authorized_at: Date.now() };
const PAGE = { cursor: "ab.3", has_more: false, changes: [], backfill: { remaining: 0 } };

function fakeEnv(overrides: Record<string, unknown> = {}) {
  const index = {
    authState: vi.fn(async () => ({ epoch: EPOCH, reauth: null as unknown })),
    syncChanges: vi.fn(async (_o: unknown) => ({ ok: true, page: PAGE }) as unknown),
    syncTask: vi.fn(async (sid: string) => (sid === "s1" ? { id: "s1", data: { title: "t" }, field_clock: {} } : null)),
    syncTaskSids: vi.fn(async (ids: string[]) => Object.fromEntries(ids.filter((i) => i !== "G-unmapped").map((i) => [i, `sid-${i}`]))),
    syncInfo: vi.fn(async () => ({
      server_id: "srv",
      cursor: "ab.3",
      account: { email: "david@example.com" },
      capabilities: { my_day: true, step_order: false, push: "none", source: "graph" },
    })),
    search: vi.fn(async (_o: unknown) => ({ rows: [{ task_id: "G1" }, { task_id: "G-unmapped" }] })),
    syncSearch: vi.fn(async (_q: string, _limit: number) => [{ id: "sid-G1", data: {}, field_clock: {} }]),
    ...overrides,
  };
  const env = {
    ownerIndex: () => index,
    TODO_CACHE: { get: async () => ({ displayName: "David" }) },
  } as unknown as AppEnv;
  return { env, index };
}

const req = (path: string, init?: RequestInit) => new Request(`https://srv.test/api/v1${path}`, init);
const body = async (res: Response) => [res.status, await res.json()];

describe("handlePublicApiRequest", () => {
  it("answers GET /sync/info without a bearer with the server_id alone", async () => {
    const { env } = fakeEnv();
    const res = (await handlePublicApiRequest(req("/sync/info"), env))!;
    expect(await body(res)).toEqual([200, { server_id: "srv" }]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["a bearer", req("/sync/info", { headers: { authorization: "Bearer x" } })],
    ["another route", req("/sync/changes")],
    ["another method", req("/sync/info", { method: "POST" })],
  ])("leaves a request with %s to the resource server", async (_label, r) => {
    expect(await handlePublicApiRequest(r, fakeEnv().env)).toBeNull();
  });
});

describe("handleApiRequest", () => {
  it.each([
    ["another epoch", { ...PROPS, epoch: "old" }, null],
    ["no props", undefined, null],
    ["pending Microsoft re-auth", PROPS, { reason: "test" }],
  ])("refuses a grant with %s before any route runs", async (_label, props, reauth) => {
    const { env, index } = fakeEnv();
    index.authState.mockResolvedValue({ epoch: EPOCH, reauth });
    const res = await handleApiRequest(req("/sync/changes"), env, props);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
    expect(index.syncChanges).not.toHaveBeenCalled();
  });

  it("passes cursor, limit and scope to the feed", async () => {
    const { env, index } = fakeEnv();
    const res = await handleApiRequest(req("/sync/changes?cursor=ab.1&limit=20&scope=active"), env, PROPS);
    expect(await body(res)).toEqual([200, PAGE]);
    expect(index.syncChanges).toHaveBeenCalledWith({ cursor: "ab.1", limit: 20, scope: "active" });
  });

  it.each([
    ["cursor_reset", 410],
    ["cursor_expired", 410],
    ["bad_cursor", 400],
    ["bad_scope", 400],
  ])("maps %s to %i", async (code, status) => {
    const { env, index } = fakeEnv();
    index.syncChanges.mockResolvedValue({ ok: false, error: code });
    expect(await body(await handleApiRequest(req("/sync/changes"), env, PROPS))).toEqual([status, { error: code }]);
  });

  it.each(["-1", "1.5", "ten", "1234567"])("refuses limit=%s", async (limit) => {
    const { env, index } = fakeEnv();
    const res = await handleApiRequest(req(`/sync/changes?limit=${limit}`), env, PROPS);
    expect(await body(res)).toEqual([400, { error: "bad_limit" }]);
    expect(index.syncChanges).not.toHaveBeenCalled();
  });

  it("serves a task by sid, and 404s an unknown or malformed one without asking the index", async () => {
    const { env, index } = fakeEnv();
    expect(await body(await handleApiRequest(req("/tasks/s1"), env, PROPS))).toEqual([
      200,
      { kind: "task", id: "s1", data: { title: "t" }, field_clock: {} },
    ]);
    expect(await body(await handleApiRequest(req("/tasks/s2"), env, PROPS))).toEqual([404, { error: "not_found" }]);
    index.syncTask.mockClear();
    for (const bad of ["a%2Fb", "%E0%A4%A", "x".repeat(65)]) {
      expect((await handleApiRequest(req(`/tasks/${bad}`), env, PROPS)).status).toBe(404);
    }
    expect(index.syncTask).not.toHaveBeenCalled();
  });

  it("searches with literal terms and returns hits as tasks", async () => {
    const { env, index } = fakeEnv();
    const res = await handleApiRequest(req(`/search?q=${encodeURIComponent('pay "the" bill')}`), env, PROPS);
    expect(await body(res)).toEqual([200, { results: [{ kind: "task", id: "sid-G1", data: {}, field_clock: {} }] }]);
    expect(index.syncSearch).toHaveBeenCalledWith('"pay"* """the"""* "bill"*', 50);
  });

  it.each(["", "   ", "x".repeat(257)])("refuses search q=%j", async (q) => {
    const { env, index } = fakeEnv();
    expect(await body(await handleApiRequest(req(`/search?q=${q}`), env, PROPS))).toEqual([400, { error: "bad_query" }]);
    expect(index.syncSearch).not.toHaveBeenCalled();
  });

  it("serves the whole info with a token, the address only as a hint", async () => {
    const { env } = fakeEnv();
    const [status, info] = await body(await handleApiRequest(req("/sync/info"), env, PROPS));
    expect(status).toBe(200);
    expect(info).toMatchObject({ server_id: "srv", cursor: "ab.3", account: { name: "David", email_hint: "d…@example.com" } });
    expect(typeof (info as { version: unknown }).version).toBe("string");
    expect(JSON.stringify(info)).not.toContain("david@");
  });

  it("answers 404 for an unknown route and 405 for a write to a read route", async () => {
    const { env } = fakeEnv();
    expect(await body(await handleApiRequest(req("/nope"), env, PROPS))).toEqual([404, { error: "not_found" }]);
    expect(await body(await handleApiRequest(req(""), env, PROPS))).toEqual([404, { error: "not_found" }]);
    const res = await handleApiRequest(req("/sync/changes", { method: "POST" }), env, PROPS);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("emailHint", () => {
  it.each([
    ["david@example.com", "d…@example.com"],
    ["a@b.c", "a…@b.c"],
    ["", null],
    ["no-at-sign", null],
    ["@example.com", null],
  ])("%j → %j", (email, hint) => expect(emailHint(email)).toBe(hint));
});

describe("ftsTerms", () => {
  it.each([
    ["pay bill", '"pay"* "bill"*'],
    ['say "hi', '"say"* """hi"*'],
    ["a OR b", '"a"* "OR"* "b"*'],
    ["  ", ""],
  ])("%j → %j", (text, query) => expect(ftsTerms(text)).toBe(query));

  it("keeps at most 16 words", () => {
    expect(ftsTerms(Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ")).split(" ")).toHaveLength(16);
  });
});
