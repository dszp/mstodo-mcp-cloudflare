// src/core/sync/executor.ts on its own: how each thrown error and each field
// shape becomes an ExecOutcome. The route tests (sync-mutations-route) cover
// the ops end to end; these reach the outcomes a scripted Graph can't.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReauthRequiredError } from "../src/core/auth/reauth";
import { GraphError } from "../src/core/graph/client";
import { SubstrateError } from "../src/core/graph/substrate-client";
import type { OpsContext } from "../src/core/ops/context";
import { WriteBusyError } from "../src/core/ops/write-lease";
import { reorderPosition, syncExecutor, taskFields } from "../src/core/sync/executor";
import type { ExecInput } from "../src/core/sync/mutations";

function ctxThrowing(e: unknown, vars: Record<string, string> = {}) {
  const markMyDayUnavailable = vi.fn(async () => {});
  const ctx = {
    env: { TIMEZONE: "UTC", ...vars },
    graph: { postJson: async () => Promise.reject(e) },
    index: { markMyDayUnavailable, findListForTask: async () => ({ list_id: "L1" }) },
    substrate: async () => Promise.reject(e),
    accessToken: async () => "t",
    writes: { run: (fn: () => Promise<unknown>) => fn() },
  } as unknown as OpsContext;
  return { ctx, markMyDayUnavailable };
}

const listCreate: ExecInput = { op: "list.create", graphId: null, fields: { name: "x" }, ids: {} };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("syncExecutor maps what an op throws", () => {
  it.each([
    ["re-auth required", new ReauthRequiredError("revoked"), { ok: false, error: "reauth_required", retry: true }],
    ["never signed in", new Error("not_authenticated"), { ok: false, error: "reauth_required", retry: true }],
    ["write queue busy", new WriteBusyError(50_000), { ok: false, error: "write_busy", retry: true }],
    ["Graph 429", new GraphError(429, "throttled"), { ok: false, error: "graph_429", retry: true }],
    ["Graph 503", new GraphError(503, "down"), { ok: false, error: "graph_503", retry: true }],
    ["Graph 400", new GraphError(400, "bad"), { ok: false, error: "graph_400", retry: false, rejected: true }],
    ["Graph 403", new GraphError(403, "forbidden"), { ok: false, error: "graph_403", retry: false, rejected: true }],
    ["network failure", new TypeError("fetch failed"), { ok: false, error: "network_error", retry: true }],
    ["a bug", new Error("boom"), { ok: false, error: "internal_error", retry: false }],
  ])("%s", async (_label, thrown, expected) => {
    expect(await syncExecutor(ctxThrowing(thrown).ctx)(listCreate)).toEqual(expected);
  });

  const myDayAdd: ExecInput = { op: "myday.add", graphId: "T1", fields: {}, ids: {} };
  it.each([
    ["Substrate 503", new SubstrateError(503, "down"), { ok: false, error: "substrate_503", retry: true }, false],
    ["Substrate 403 (latched)", new SubstrateError(403, "no scope"), { ok: false, error: "my_day_unavailable", retry: false }, true],
    ["EXO scope not consented", new Error("my_day_unavailable"), { ok: false, error: "my_day_unavailable", retry: false }, false],
    ["Substrate 404", new SubstrateError(404, "gone"), { ok: false, error: "substrate_404", retry: false, rejected: true }, false],
  ])("%s", async (_label, thrown, expected, latched) => {
    const { ctx, markMyDayUnavailable } = ctxThrowing(thrown, { ENABLE_MY_DAY: "true" });
    expect(await syncExecutor(ctx)(myDayAdd)).toEqual(expected);
    expect(markMyDayUnavailable.mock.calls.length > 0).toBe(latched);
  });
});

describe("syncExecutor gates Substrate ops on ENABLE_MY_DAY", () => {
  const ids = { "0190a1b2c3d47e5f8a9b000000000001": "L2" };
  it.each([
    ["myday.add", { op: "myday.add", graphId: "T1", fields: {}, ids: {} }],
    ["myday.remove", { op: "myday.remove", graphId: "T1", fields: {}, ids: {} }],
    ["myday.reorder", { op: "myday.reorder", graphId: "T1", fields: {}, position: { top: true }, ids: {} }],
    ["task.reorder", { op: "task.reorder", graphId: "T1", fields: {}, position: { top: true }, ids: {} }],
    ["step.reorder", { op: "step.reorder", graphId: "S1", fields: {}, position: { top: true }, ids: {} }],
    [
      "task.move with a position",
      { op: "task.move", graphId: "T1", fields: { list_id: "0190a1b2c3d47e5f8a9b000000000001" }, position: { top: true }, ids },
    ],
  ] as Array<[string, ExecInput]>)("%s", async (_label, input) => {
    expect(await syncExecutor(ctxThrowing(new Error("unreached")).ctx)(input)).toEqual({
      ok: false,
      error: "my_day_disabled",
      retry: false,
      rejected: true,
    });
  });
});

describe("taskFields translates the feed's shapes to the ops' input", () => {
  it("translates every field", () => {
    expect(
      taskFields({
        title: "t",
        body: { type: "text", content: "b" },
        status: "inProgress",
        importance: "low",
        completed_at: "2026-11-24T23:30:00-05:00",
        due: "2026-11-25",
        start: null,
        reminder: { on: false, at: null },
        categories: ["Red"],
        recurrence: null,
      }),
    ).toEqual({
      title: "t",
      body: "b",
      status: "inProgress",
      importance: "low",
      completed_date: "2026-11-25",
      due: "2026-11-25",
      start: null,
      reminder: null,
      isReminderOn: false,
      categories: ["Red"],
      recurrence: null,
    });
  });

  it("takes a plain-string body and clears with null", () => {
    expect(taskFields({ body: "plain" })).toEqual({ body: "plain" });
    expect(taskFields({ body: null, completed_at: null, reminder: null })).toEqual({
      body: "",
      completed_date: null,
      reminder: null,
      isReminderOn: false,
    });
  });

  it.each([
    ["an HTML body", { body: { type: "html", content: "<b>x</b>" } }, "body"],
    ["an unknown status", { status: "done" }, "status"],
    ["a due date with a time", { due: "2026-11-25T09:00" }, "due"],
    ["an unparseable completed_at", { completed_at: "yesterday" }, "completed_at"],
    ["a reminder without on", { reminder: { at: "2026-11-25T09:00:00Z" } }, "reminder"],
    ["categories that aren't strings", { categories: [1] }, "categories"],
    ["an empty title", { title: "  " }, "title"],
  ])("refuses %s", async (_label, fields, field) => {
    const out = await syncExecutor(ctxThrowing(new Error("unreached")).ctx)({ op: "task.update", graphId: "T1", fields, ids: {} });
    expect(out).toEqual({ ok: false, error: `invalid_field:${field}`, retry: false, rejected: true });
  });
});

describe("reorderPosition", () => {
  const ids = { "0190a1b2c3d47e5f8a9b000000000001": "G-ref" };
  it.each([
    [{ top: true as const }, { kind: "top" }],
    [{ bottom: true as const }, { kind: "bottom" }],
    [{ before: "0190A1B2C3D47E5F8A9B000000000001" }, { kind: "before", reference_id: "G-ref" }],
    [{ after: "0190a1b2c3d47e5f8a9b000000000001" }, { kind: "after", reference_id: "G-ref" }],
  ])("%j", (p, expected) => {
    expect(reorderPosition(p, ids)).toEqual(expected);
  });
});
