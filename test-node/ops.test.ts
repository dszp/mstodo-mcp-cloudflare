// Unit tests for src/core/ops called directly, the way the sync mutations
// endpoint will call them: Graph IDs in, typed results out, no MCP envelope.
// The MCP-facing behavior is pinned by write-tools.test.ts; these cover the
// op contract and the paths those snapshots don't reach.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { buildNodeEnv } from "../src/hosts/node/env";
import { GraphClient } from "../src/core/graph/client";
import { SubstrateClient } from "../src/core/graph/substrate-client";
import { LinkRulesConfigSchema } from "../src/core/config/schemas";
import { storeLinkRules } from "../src/core/config/loader";
import { opsContext, type OpsContext } from "../src/core/ops/context";
import { WriteLease } from "../src/core/ops/write-lease";
import { computeOrder } from "../src/core/ops/position";
import { err, ok } from "../src/core/ops/result";
import { createTask, moveTask, updateTask } from "../src/core/ops/tasks";
import { createList } from "../src/core/ops/lists";
import { createStep } from "../src/core/ops/steps";
import { reorderMyDayTask } from "../src/core/ops/my-day";

const G = "https://graph.microsoft.com/v1.0/me/todo/lists";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const task = (id: string, extra: object = {}) => ({ id, title: `title ${id}`, status: "notStarted", ...extra });

type Route = (method: string, url: string, body: unknown) => Response | Promise<Response> | undefined;

function setup(opts: { vars?: Record<string, string>; routes: Route[] }) {
  const { env, core } = buildNodeEnv(openDatabase(":memory:"), {
    TIMEZONE: "UTC",
    MS_TENANT_ID: "t",
    MS_CLIENT_ID: "c",
    MS_CLIENT_SECRET: "s",
    OWNER_EMAIL: "o@example.com",
    ...opts.vars,
  });
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      for (const r of opts.routes) {
        const res = await r(method, url, body);
        if (res) return res;
      }
      return json({ error: { code: "Unscripted" } }, 418);
    }),
  );
  const ctx = (): OpsContext =>
    opsContext({
      env,
      graph: new GraphClient({ getAccessToken: async () => "t", forceRefresh: async () => "t" }),
      index: env.ownerIndex(),
      substrate: async () => new SubstrateClient({ getSubstrateAccessToken: async () => "s", forceSubstrateRefresh: async () => "s" }, null),
      accessToken: async () => "t",
    });
  return { env, core, calls, ctx };
}

const on = (method: string, url: string, res: (body: unknown) => Response | Promise<Response>): Route => (m, u, b) =>
  m === method && u === url ? res(b) : undefined;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ops share one write queue", () => {
  it("a second writer's Graph calls wait for the first writer to finish", async () => {
    let releaseCreate!: () => void;
    const createHeld = new Promise<void>((r) => (releaseCreate = r));
    const h = setup({
      routes: [
        on("POST", `${G}/L1/tasks`, async () => {
          await createHeld;
          return json(task("T1"), 201);
        }),
        on("POST", G, () => json({ id: "L2", displayName: "New" }, 201)),
      ],
    });
    const first = createTask(h.ctx(), { list_id: "L1", title: "x" });
    await vi.waitFor(() => expect(h.calls).toEqual([`POST ${G}/L1/tasks`]));
    const second = createList(h.ctx(), { display_name: "New" });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.calls).toEqual([`POST ${G}/L1/tasks`]);
    releaseCreate();
    expect((await first).ok).toBe(true);
    expect(await second).toEqual(ok({ list: { id: "L2", displayName: "New" } }));
    expect(h.calls).toEqual([`POST ${G}/L1/tasks`, `POST ${G}`]);
  });

  it("an op inside a caller-held lease runs without waiting on itself", async () => {
    const h = setup({ routes: [on("POST", G, () => json({ id: "L2", displayName: "New" }, 201))] });
    const writes = new WriteLease(h.env.ownerIndex(), { waitMs: 200 });
    const ctx = { ...h.ctx(), writes };
    // A sync batch holds the lease around its mutations.
    const r = await writes.run(() => createList(ctx, { display_name: "New" }));
    expect(r.ok).toBe(true);
  });
});

describe("task ops", () => {
  it("createTask applies a matching link rule and reports it", async () => {
    const h = setup({
      routes: [
        on("POST", `${G}/L1/tasks`, (b) => json(task("T1", b as object), 201)),
        on("POST", `${G}/L1/tasks/T1/linkedResources`, (b) => json({ id: "k1", ...(b as object) }, 201)),
      ],
    });
    await storeLinkRules(
      h.env,
      LinkRulesConfigSchema.parse({ rules: [{ id: "tix", pattern: "TIX-(\\d+)", url_template: "https://tix.example/$1" }] }),
    );
    const r = await createTask(h.ctx(), { list_id: "L1", title: "Fix TIX-42" });
    expect(r.ok && r.value.link_rules.created.map((m) => m.url)).toEqual(["https://tix.example/42"]);
    expect(h.core.query({} as never).rows.map((t) => t.task_id)).toEqual(["T1"]);
  });

  it("updateTask leaves link_rules out unless title or body changed", async () => {
    const h = setup({ routes: [on("PATCH", `${G}/L1/tasks/T1`, (b) => json(task("T1", b as object)))] });
    const r = await updateTask(h.ctx(), { list_id: "L1", task_id: "T1", importance: "high" });
    expect(r.ok).toBe(true);
    expect(r.ok && "link_rules" in r.value).toBe(false);
  });

  it("moveTask reports an orphaned copy when the abort cleanup fails", async () => {
    const h = setup({
      routes: [
        on("GET", `${G}/L1/tasks/T1?%24expand=checklistItems%2ClinkedResources%2Cattachments`, () =>
          json(task("T1", { checklistItems: [{ id: "c1", displayName: "step" }] })),
        ),
        on("POST", `${G}/L2/tasks`, () => json(task("T2"), 201)),
        on("POST", `${G}/L2/tasks/T2/checklistItems`, () => json({ error: { code: "x" } }, 400)),
        on("DELETE", `${G}/L2/tasks/T2`, () => json({ error: { code: "busy" } }, 503)),
      ],
    });
    const r = await moveTask(h.ctx(), { task_id: "T1", from_list_id: "L1", to_list_id: "L2" });
    expect(r).toMatchObject(
      ok({ status: "aborted", error: "checklist_copy_failed", task_id: "T1", cleanup_succeeded: false, orphan_task_id: "T2", checklist_copied: 0 }),
    );
    // The source was never deleted.
    expect(h.calls).not.toContain(`DELETE ${G}/L1/tasks/T1`);
  });

  it("moveTask refuses to drop a reference attachment it can't copy", async () => {
    const h = setup({
      routes: [
        on("GET", `${G}/L1/tasks/T1?%24expand=checklistItems%2ClinkedResources%2Cattachments`, () => json(task("T1", { hasAttachments: true }))),
        on("POST", `${G}/L2/tasks`, () => json(task("T2"), 201)),
        on("GET", `${G}/L1/tasks/T1/attachments`, () =>
          json({ value: [{ "@odata.type": "#microsoft.graph.taskReferenceAttachment", id: "a1", name: "doc" }] }),
        ),
        on("DELETE", `${G}/L2/tasks/T2`, () => new Response(null, { status: 204 })),
      ],
    });
    const r = await moveTask(h.ctx(), { task_id: "T1", from_list_id: "L1", to_list_id: "L2" });
    expect(r).toMatchObject(ok({ status: "aborted", error: "reference_attachment_not_copyable", attachment_id: "a1", cleanup_succeeded: true }));
    expect(r.ok && "orphan_task_id" in r.value).toBe(false);
  });
});

describe("createStep", () => {
  it("skips the checklist cache when it is off but still flags the task", async () => {
    const h = setup({
      vars: { ENABLE_CHECKLIST_CACHE: "false" },
      routes: [on("POST", `${G}/L1/tasks/T1/checklistItems`, (b) => json({ id: "c1", ...(b as object) }, 201))],
    });
    h.core.upsertTask(task("T1") as never, "L1");
    const r = await createStep(h.ctx(), { list_id: "L1", task_id: "T1", display_name: "step" });
    expect(r).toEqual(ok({ list_id: "L1", task_id: "T1", item: { id: "c1", displayName: "step" } }));
    expect(h.core.getChecklistItems("T1")).toEqual([]);
    expect(h.core.query({} as never).rows[0]).toMatchObject({ has_checklist: 1 });
  });
});

describe("reorder positions", () => {
  it("reorderMyDayTask validates a raw 'set' order itself (the sync API path)", async () => {
    const h = setup({ routes: [] });
    const r = await reorderMyDayTask(h.ctx(), { list_id: "L1", task_id: "T1", date: "2026-11-24", position: { kind: "set", order: "soon" } });
    expect(r).toEqual(err("invalid_order", { order: "soon", hint: "Use an ISO 8601 timestamp." }));
    expect(h.calls).toEqual([]);
  });

  it("computeOrder places relative to the reference and reports exhausted precision", async () => {
    const src = (orders: string[], ref: string | null) => ({
      neighbors: () => orders.map((o) => Date.parse(o)),
      reference: async () => ok(ref),
      noOrder: (id: string) => err("no_order", { id }),
    });
    const a = "2026-11-01T00:00:00.000Z";
    const b = "2026-11-03T00:00:00.000Z";
    expect(await computeOrder({ kind: "after", reference_id: "B" }, src([a, b], b))).toEqual(ok("2026-11-02T00:00:00.000Z"));
    expect(await computeOrder({ kind: "before", reference_id: "X" }, src([a], null))).toEqual(err("no_order", { id: "X" }));
    const tight = ["2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.001Z"];
    expect(await computeOrder({ kind: "before", reference_id: "B" }, src(tight, tight[0]))).toMatchObject({
      ok: false,
      reason: "order_precision_exhausted",
    });
  });

  it("computeOrder never reads neighbors for 'set'", async () => {
    const neighbors = vi.fn(() => []);
    const r = await computeOrder({ kind: "set", order: "2026-12-01T00:00:00.000Z" }, { neighbors, reference: async () => ok(null), noOrder: () => err("x") });
    expect(r).toEqual(ok("2026-12-01T00:00:00.000Z"));
    expect(neighbors).not.toHaveBeenCalled();
  });
});
