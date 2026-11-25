// Writing a list's sidebar appearance (docs/SYNC-API.md section 10.4): theme
// and group through list.update, position through list.reorder. The executor
// runs against a fake index and a fake Substrate client, so each test pins the
// folder PATCH body and the outcome.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SubstrateError, type SubstrateFolder } from "../src/core/graph/substrate-client";
import type { OpsContext } from "../src/core/ops/context";
import { syncExecutor } from "../src/core/sync/executor";
import { wholeSecondOrder } from "../src/core/ops/lists";
import { refsOf, type ExecInput } from "../src/core/sync/mutations";

type SideList = { list_id: string; group_id: string | null; order_datetime: string | null; wellknown: string | null };

// Top level, top first: G2 (…49.248Z), Lb (…47Z), G1 (…45.623Z), La (2026-05-19).
// In G1: Lg2 (…20Z) above Lg1 (…10Z). The default list has no order.
const LISTS: SideList[] = [
  { list_id: "Ldef", group_id: null, order_datetime: null, wellknown: "defaultList" },
  { list_id: "La", group_id: null, order_datetime: "2026-05-19T11:01:00Z", wellknown: "none" },
  { list_id: "Lb", group_id: null, order_datetime: "2026-11-23T23:45:47Z", wellknown: "none" },
  { list_id: "Lg1", group_id: "G1", order_datetime: "2026-11-23T23:45:10Z", wellknown: "none" },
  { list_id: "Lg2", group_id: "G1", order_datetime: "2026-11-23T23:45:20Z", wellknown: "none" },
];
const GROUPS = [
  { group_id: "G1", order_datetime: "2026-11-23T23:45:45.623Z" },
  { group_id: "G2", order_datetime: "2026-11-23T23:45:49.248Z" },
];
const SIDS: Record<string, { kind: string; id: string }> = {
  "0190a1b2c3d47e5f8a9b0000000000a1": { kind: "list", id: "La" },
  "0190a1b2c3d47e5f8a9b0000000000b1": { kind: "list", id: "Lb" },
  "0190a1b2c3d47e5f8a9b0000000000c1": { kind: "list", id: "Lg2" },
  "0190a1b2c3d47e5f8a9b0000000000d1": { kind: "list_group", id: "G1" },
  "0190a1b2c3d47e5f8a9b0000000000d2": { kind: "list_group", id: "G2" },
};
const sidOf = (id: string) => Object.keys(SIDS).find((s) => SIDS[s].id === id)!;

function harness(opts: { myDay?: boolean; patchError?: unknown } = {}) {
  const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
  const stored: SubstrateFolder[] = [];
  const markMyDayUnavailable = vi.fn(async () => {});
  const ctx = {
    env: { TIMEZONE: "UTC", ENABLE_MY_DAY: opts.myDay === false ? "false" : "true" },
    graph: {},
    index: {
      markMyDayUnavailable,
      sidebar: async () => ({ lists: LISTS, groups: GROUPS }),
      storeFolderAppearance: async (f: SubstrateFolder) => void stored.push(f),
      resolveSids: async (refs: Array<{ kind: string; sid: string }>) =>
        Object.fromEntries(
          refs.map((r) => {
            const hit = SIDS[r.sid]?.kind === r.kind ? SIDS[r.sid] : undefined;
            return [`${r.kind}:${r.sid}`, { graph_id: hit?.id ?? null, live: !!hit }];
          }),
        ),
    },
    substrate: async () => ({
      patchFolder: async (id: string, body: Record<string, unknown>) => {
        if (opts.patchError) throw opts.patchError;
        patches.push({ id, body });
        return { Id: id, ...body } as SubstrateFolder;
      },
    }),
    accessToken: async () => "t",
    writes: { run: (fn: () => Promise<unknown>) => fn() },
  } as unknown as OpsContext;
  return { exec: syncExecutor(ctx), patches, stored, markMyDayUnavailable };
}

const S = "0190a1b2c3d47e5f8a9b0000000000ff";
const update = (graphId: string, fields: Record<string, unknown>, ids: Record<string, string> = {}): ExecInput => ({
  op: "list.update", sid: S, graphId, fields, ids,
});
const reorder = (graphId: string, position: ExecInput["position"]): ExecInput => ({
  op: "list.reorder", sid: S, graphId, fields: {}, position, ids: {},
});
const rejected = (error: string) => ({ ok: false, error, retry: false, rejected: true });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("list.update theme", () => {
  it("writes the names to the folder and stores what Substrate returns", async () => {
    const h = harness();
    expect(await h.exec(update("La", { theme: { color: "red", background: "beach" } }))).toEqual({ ok: true, graphId: "La" });
    expect(h.patches).toEqual([{ id: "La", body: { ThemeColor: "red", ThemeBackground: "beach" } }]);
    expect(h.stored).toEqual([{ Id: "La", ThemeColor: "red", ThemeBackground: "beach" }]);
  });

  it("sends only the part that was set", async () => {
    const h = harness();
    await h.exec(update("La", { theme: { background: "mountain" } }));
    expect(h.patches[0].body).toEqual({ ThemeBackground: "mountain" });
  });

  it.each([
    ["null (Substrate ignores it)", { color: null }],
    ["an empty name (Substrate stores it)", { background: "" }],
    ["an unknown key", { colour: "red" }],
    ["no keys", {}],
    ["text that isn't a name", { color: "red; drop" }],
    ["a string instead of an object", "red"],
  ])("refuses %s", async (_label, theme) => {
    const h = harness();
    expect(await h.exec(update("La", { theme }))).toEqual(rejected("invalid_field:theme"));
    expect(h.patches).toEqual([]);
  });
});

describe("list.update group_id", () => {
  const G1 = sidOf("G1");
  it("moves a list into the group the sid names", async () => {
    const h = harness();
    expect(await h.exec(update("La", { group_id: G1 }, { [G1]: "G1" }))).toEqual({ ok: true, graphId: "La" });
    expect(h.patches).toEqual([{ id: "La", body: { ParentFolderGroupId: "G1" } }]);
  });

  it("takes a list out of its group with null", async () => {
    const h = harness();
    await h.exec(update("Lg1", { group_id: null }));
    expect(h.patches).toEqual([{ id: "Lg1", body: { ParentFolderGroupId: null } }]);
  });

  it("refuses to group the default list", async () => {
    const h = harness();
    expect(await h.exec(update("Ldef", { group_id: G1 }, { [G1]: "G1" }))).toEqual(rejected("default_list"));
    expect(h.patches).toEqual([]);
  });

  it("names the group sid as a reference, so the batch resolves it", () => {
    expect(refsOf({ id: "m", at: "2026-11-25T00:00:00Z", op: "list.update", sid: S, fields: { group_id: G1 } })).toEqual([
      { kind: "list", sid: S },
      { kind: "list_group", sid: G1 },
    ]);
  });
});

describe("list.reorder", () => {
  const order = (h: ReturnType<typeof harness>) => h.patches[0]?.body.OrderDateTime;

  it("puts a top-level list just above a group", async () => {
    const h = harness();
    expect(await h.exec(reorder("La", { before: sidOf("G1") }))).toEqual({ ok: true, graphId: "La" });
    // Between G1 (…45.623Z) and Lb (…47Z), to the whole second.
    expect(order(h)).toBe("2026-11-23T23:45:46Z");
  });

  it("puts a top-level list just below another list", async () => {
    const h = harness();
    await h.exec(reorder("La", { after: sidOf("Lb") }));
    // Between Lb (…47Z) and G1 (…45.623Z), to the whole second.
    expect(order(h)).toBe("2026-11-23T23:45:46Z");
  });

  it("orders a grouped list among its group's lists only", async () => {
    const h = harness();
    await h.exec(reorder("Lg1", { top: true }));
    // A minute above Lg2, its only sibling; the top-level items don't count.
    expect(order(h)).toBe("2026-11-23T23:46:20Z");
  });

  it("refuses a reference outside the list's own container", async () => {
    const h = harness();
    expect(await h.exec(reorder("Lg1", { before: sidOf("Lb") }))).toEqual(rejected("reference_not_sibling"));
    expect(h.patches).toEqual([]);
  });

  it("refuses to move the default list", async () => {
    expect(await harness().exec(reorder("Ldef", { top: true }))).toEqual(rejected("default_list"));
  });

  it("refuses a reference sid it can't find", async () => {
    expect(await harness().exec(reorder("La", { before: "0190a1b2c3d47e5f8a9b0000000000ee" }))).toEqual(
      rejected("unknown_reference"),
    );
  });

  it("leaves the reference to the executor, since it may be a group", () => {
    expect(refsOf({ id: "m", at: "2026-11-25T00:00:00Z", op: "list.reorder", sid: S, position: { before: sidOf("G1") } })).toEqual([
      { kind: "list", sid: S },
    ]);
  });
});

describe("appearance writes need Substrate", () => {
  it.each([
    ["theme", update("La", { theme: { color: "red" } })],
    ["group", update("La", { group_id: null })],
    ["reorder", reorder("La", { top: true })],
  ])("refuses %s when ENABLE_MY_DAY is off", async (_label, input) => {
    const h = harness({ myDay: false });
    expect(await h.exec(input)).toEqual(rejected("list_appearance_unavailable"));
    expect(h.patches).toEqual([]);
  });

  it("a 403 refuses the edit without turning My Day off", async () => {
    const h = harness({ patchError: new SubstrateError(403, "forbidden") });
    expect(await h.exec(update("La", { theme: { color: "red" } }))).toEqual(rejected("list_appearance_unavailable"));
    expect(h.markMyDayUnavailable).not.toHaveBeenCalled();
  });

  it("a 404 is list_not_found", async () => {
    const h = harness({ patchError: new SubstrateError(404, "gone") });
    expect(await h.exec(update("La", { theme: { color: "red" } }))).toEqual(rejected("list_not_found"));
  });

});

describe("wholeSecondOrder (Substrate keeps a list's order to the second)", () => {
  const t = (iso: string) => Date.parse(iso);
  it("rounds down when that keeps the place", () => {
    expect(wholeSecondOrder("2026-11-23T23:45:46.311Z", [t("2026-11-23T23:45:47Z"), t("2026-11-23T23:45:45.623Z")])).toBe(
      "2026-11-23T23:45:46Z",
    );
  });
  it("rounds up when rounding down would pass the neighbor below", () => {
    // Between …49.1 (below) and …50.9 (above): …49 is under the lower one, …50 fits.
    expect(wholeSecondOrder("2026-11-23T23:45:49.500Z", [t("2026-11-23T23:45:50.900Z"), t("2026-11-23T23:45:49.100Z")])).toBe(
      "2026-11-23T23:45:50Z",
    );
  });
  it("refuses when no whole second fits between the neighbors", () => {
    expect(wholeSecondOrder("2026-11-23T23:45:49.500Z", [t("2026-11-23T23:45:49.900Z"), t("2026-11-23T23:45:49.100Z")])).toBeNull();
  });
  it("refuses a whole second a neighbor already holds", () => {
    expect(wholeSecondOrder("2026-11-23T23:45:49.500Z", [t("2026-11-23T23:45:50Z"), t("2026-11-23T23:45:49Z")])).toBeNull();
  });
});
