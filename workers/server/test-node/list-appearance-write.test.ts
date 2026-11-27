// Writing a list's sidebar appearance (docs/SYNC-API.md section 10.4): theme
// and group through list.update, position through list.reorder. The executor
// runs against a fake index and a fake Substrate client, so each test pins the
// folder PATCH body and the outcome.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SubstrateError, type SubstrateFolder, type SubstrateFolderGroup } from "@potem/core/graph/substrate-client";
import type { OpsContext } from "@potem/core/ops/context";
import { syncExecutor } from "@potem/core/sync/executor";
import { wholeSecondOrder } from "@potem/core/ops/lists";
import { refsOf, type ExecInput } from "@potem/core/sync/mutations";

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

function harness(
  opts: {
    myDay?: boolean;
    patchError?: unknown;
    // A folder PATCH error for one list only.
    patchErrorFor?: Record<string, unknown>;
    deleteError?: unknown;
    // When the first sidebar read succeeded; null if none has.
    sidebarFirstReadAt?: number | null;
    // What Substrate holds, where it differs from the mirror's LISTS / GROUPS.
    folders?: Array<{ Id: string; ParentFolderGroupId: string | null }>;
    substrateGroups?: SubstrateFolderGroup[];
    seen?: Record<string, { first_seen_ms: number; app_owned: boolean }>;
  } = {},
) {
  const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
  const stored: SubstrateFolder[] = [];
  const groupCalls: Array<{ call: string; id?: string; body?: Record<string, unknown> }> = [];
  const storedGroups: SubstrateFolderGroup[] = [];
  const removedGroups: string[] = [];
  const reserved: Array<{ kind: string; sid: string; graphId: string }> = [];
  const markMyDayUnavailable = vi.fn(async () => {});
  const ctx = {
    env: { TIMEZONE: "UTC", ENABLE_MY_DAY: opts.myDay === false ? "false" : "true" },
    graph: {},
    index: {
      markMyDayUnavailable,
      sidebar: async () => ({ lists: LISTS, groups: GROUPS }),
      storeFolderAppearance: async (f: SubstrateFolder) => void stored.push(f),
      storeFolderGroup: async (g: SubstrateFolderGroup) => void storedGroups.push(g),
      removeFolderGroup: async (id: string) => void removedGroups.push(id),
      sidebarFirstReadAt: async () => (opts.sidebarFirstReadAt === undefined ? 1 : opts.sidebarFirstReadAt),
      reserveSid: async (kind: string, sid: string, graphId: string) => (reserved.push({ kind, sid, graphId }), true),
      createCandidates: async (_kind: string, ids: string[]) =>
        Object.fromEntries(ids.filter((id) => opts.seen?.[id]).map((id) => [id, opts.seen![id]])),
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
        if (opts.patchErrorFor?.[id]) throw opts.patchErrorFor[id];
        patches.push({ id, body });
        return { Id: id, ...body } as SubstrateFolder;
      },
      listFolders: async () =>
        opts.folders ?? LISTS.map((l) => ({ Id: l.list_id, ParentFolderGroupId: l.group_id })),
      listFolderGroups: async () => opts.substrateGroups ?? [],
      createFolderGroup: async (body: Record<string, unknown>) => {
        if (opts.patchError) throw opts.patchError;
        groupCalls.push({ call: "create", body });
        return { Id: "Gnew", ...body } as SubstrateFolderGroup;
      },
      patchFolderGroup: async (id: string, body: Record<string, unknown>) => {
        if (opts.patchError) throw opts.patchError;
        groupCalls.push({ call: "patch", id, body });
        return { Id: id, ...body } as SubstrateFolderGroup;
      },
      deleteFolderGroup: async (id: string) => {
        if (opts.deleteError) throw opts.deleteError;
        groupCalls.push({ call: "delete", id });
      },
    }),
    accessToken: async () => "t",
    writes: { run: (fn: () => Promise<unknown>) => fn() },
  } as unknown as OpsContext;
  return { exec: syncExecutor(ctx), patches, stored, markMyDayUnavailable, groupCalls, storedGroups, removedGroups, reserved };
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
  it("writes the color alone and stores what Substrate returns", async () => {
    const h = harness();
    expect(await h.exec(update("La", { theme: { color: "dark_purple" } }))).toEqual({ ok: true, graphId: "La" });
    // No ThemeBackground in the body: Substrate keeps the list's background.
    expect(h.patches).toEqual([{ id: "La", body: { ThemeColor: "dark_purple" } }]);
    expect(h.stored).toEqual([{ Id: "La", ThemeColor: "dark_purple" }]);
  });

  it.each([
    ["null (Substrate ignores it)", { color: null }],
    ["an empty name (Substrate stores it)", { background: "" }],
    ["an unknown key", { colour: "red" }],
    ["no keys", {}],
    ["text that isn't a name", { color: "red; drop" }],
    ["a color To Do hasn't been seen to use", { color: "chartreuse" }],
    ["a plain color name To Do hasn't been seen to use", { color: "red" }],
    ["a background (not writable yet)", { background: "mountain" }],
    ["a color with a background", { color: "blue", background: "beach" }],
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
    ["theme", update("La", { theme: { color: "blue" } })],
    ["group", update("La", { group_id: null })],
    ["reorder", reorder("La", { top: true })],
  ])("refuses %s when ENABLE_MY_DAY is off", async (_label, input) => {
    const h = harness({ myDay: false });
    expect(await h.exec(input)).toEqual(rejected("list_appearance_unavailable"));
    expect(h.patches).toEqual([]);
  });

  it("a 403 refuses the edit without turning My Day off", async () => {
    const h = harness({ patchError: new SubstrateError(403, "forbidden") });
    expect(await h.exec(update("La", { theme: { color: "blue" } }))).toEqual(rejected("list_appearance_unavailable"));
    expect(h.markMyDayUnavailable).not.toHaveBeenCalled();
  });

  it("a 404 is list_not_found", async () => {
    const h = harness({ patchError: new SubstrateError(404, "gone") });
    expect(await h.exec(update("La", { theme: { color: "blue" } }))).toEqual(rejected("list_not_found"));
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

describe("list groups", () => {
  const G1 = sidOf("G1");
  const op = (o: ExecInput["op"], graphId: string | null, fields: Record<string, unknown> = {}, position?: ExecInput["position"]): ExecInput => ({
    op: o, sid: S, graphId, fields, position, ids: {},
  });

  it("creates a group at the top, under the app's sid", async () => {
    const h = harness();
    expect(await h.exec(op("list_group.create", null, { name: "Work" }))).toEqual({ ok: true, graphId: "Gnew" });
    // A minute above G2 (…49.248Z), the top item. Groups keep milliseconds.
    expect(h.groupCalls).toEqual([{ call: "create", body: { Name: "Work", OrderDateTime: "2026-11-23T23:46:49.248Z" } }]);
    expect(h.reserved).toEqual([{ kind: "list_group", sid: S, graphId: "Gnew" }]);
    expect(h.storedGroups.map((g) => g.Id)).toEqual(["Gnew"]);
  });

  it("creates a group at a position among the top-level items", async () => {
    const h = harness();
    await h.exec(op("list_group.create", null, { name: "Work" }, { after: sidOf("Lb") }));
    // Between Lb (…47Z) and G1 (…45.623Z).
    expect(h.groupCalls[0].body?.OrderDateTime).toBe("2026-11-23T23:45:46.311Z");
  });

  it("on a retried create, adopts the one group with that name the first attempt made", async () => {
    const h = harness({
      substrateGroups: [{ Id: "Gold", Name: "Work" }, { Id: "Gmade", Name: "Work" }, { Id: "Gx", Name: "Home" }],
      seen: { Gold: { first_seen_ms: 1, app_owned: false } },
    });
    const r = await h.exec({ ...op("list_group.create", null, { name: "Work" }), priorAttemptMs: 1_000 });
    expect(r).toEqual({ ok: true, graphId: "Gmade" });
    expect(h.groupCalls).toEqual([]);
    expect(h.reserved).toEqual([{ kind: "list_group", sid: S, graphId: "Gmade" }]);
  });

  it("on a retried create before any sidebar read, refuses rather than guess", async () => {
    // Every existing group is unseen until the first read, so "Work" may predate the attempt.
    const h = harness({ substrateGroups: [{ Id: "Gold", Name: "Work" }], sidebarFirstReadAt: null });
    const r = await h.exec({ ...op("list_group.create", null, { name: "Work" }), priorAttemptMs: 1_000 });
    expect(r).toEqual(rejected("ambiguous_create"));
    expect(h.groupCalls).toEqual([]);
    expect(h.reserved).toEqual([]);
  });

  it("on a retried create whose attempt came before the first sidebar read, refuses", async () => {
    // The first read (at 2 000) stamped the person's own "Work" as first seen after the attempt (1 000).
    const h = harness({
      substrateGroups: [{ Id: "Gold", Name: "Work" }],
      seen: { Gold: { first_seen_ms: 2_000, app_owned: false } },
      sidebarFirstReadAt: 2_000,
    });
    const r = await h.exec({ ...op("list_group.create", null, { name: "Work" }), priorAttemptMs: 1_000 });
    expect(r).toEqual(rejected("ambiguous_create"));
    expect(h.reserved).toEqual([]);
  });

  it("on a retried create with no matching group, creates it even before any sidebar read", async () => {
    const h = harness({ substrateGroups: [{ Id: "Gx", Name: "Home" }], sidebarFirstReadAt: null });
    const r = await h.exec({ ...op("list_group.create", null, { name: "Work" }), priorAttemptMs: 1_000 });
    expect(r).toEqual({ ok: true, graphId: "Gnew" });
  });

  it("renames a group", async () => {
    const h = harness();
    expect(await h.exec(op("list_group.update", "G1", { name: "Home" }))).toEqual({ ok: true, graphId: "G1" });
    expect(h.groupCalls).toEqual([{ call: "patch", id: "G1", body: { Name: "Home" } }]);
  });

  it("refuses an empty name", async () => {
    const h = harness();
    expect(await h.exec(op("list_group.update", "G1", { name: " " }))).toEqual(rejected("invalid_field:name"));
    expect(h.groupCalls).toEqual([]);
  });

  it("moves a group among the top-level lists and the other groups", async () => {
    const h = harness();
    await h.exec(op("list_group.reorder", "G1", {}, { before: sidOf("Lb") }));
    // Between G2 (…49.248Z) and Lb (…47Z); G1 itself doesn't count.
    expect(h.groupCalls).toEqual([{ call: "patch", id: "G1", body: { OrderDateTime: "2026-11-23T23:45:48.124Z" } }]);
  });

  it("refuses a reference inside a group", async () => {
    const h = harness();
    expect(await h.exec(op("list_group.reorder", "G1", {}, { before: sidOf("Lg2") }))).toEqual(rejected("reference_not_sibling"));
    expect(h.groupCalls).toEqual([]);
  });

  it("deletes a group after moving its lists out, by Substrate's membership", async () => {
    // The mirror has Lg1 and Lg2 in G1; Substrate also has La there.
    const h = harness({
      folders: [
        { Id: "La", ParentFolderGroupId: "G1" },
        { Id: "Lg1", ParentFolderGroupId: "G1" },
        { Id: "Lg2", ParentFolderGroupId: null },
      ],
    });
    expect(await h.exec(op("list_group.delete", "G1"))).toEqual({ ok: true, graphId: "G1" });
    expect(h.patches).toEqual([
      { id: "La", body: { ParentFolderGroupId: null } },
      { id: "Lg1", body: { ParentFolderGroupId: null } },
    ]);
    expect(h.groupCalls).toEqual([{ call: "delete", id: "G1" }]);
    expect(h.removedGroups).toEqual(["G1"]);
  });

  it("skips a member list deleted since the read and still deletes the group", async () => {
    const h = harness({
      folders: [
        { Id: "Lgone", ParentFolderGroupId: "G1" },
        { Id: "Lg1", ParentFolderGroupId: "G1" },
      ],
      patchErrorFor: { Lgone: new SubstrateError(404, "gone") },
    });
    expect(await h.exec(op("list_group.delete", "G1"))).toEqual({ ok: true, graphId: "G1" });
    expect(h.patches).toEqual([{ id: "Lg1", body: { ParentFolderGroupId: null } }]);
    expect(h.groupCalls).toEqual([{ call: "delete", id: "G1" }]);
    expect(h.removedGroups).toEqual(["G1"]);
  });

  it("a group already gone counts as deleted and leaves the mirror", async () => {
    const h = harness({ deleteError: new SubstrateError(404, "gone") });
    expect(await h.exec(op("list_group.delete", "G2"))).toEqual({ ok: true, graphId: "G2" });
    expect(h.removedGroups).toEqual(["G2"]);
  });

  it.each([
    ["create", op("list_group.create", null, { name: "Work" })],
    ["rename", op("list_group.update", "G1", { name: "Home" })],
    ["reorder", op("list_group.reorder", "G1", {}, { top: true })],
    ["delete", op("list_group.delete", "G1")],
  ])("refuses %s when ENABLE_MY_DAY is off", async (_label, input) => {
    const h = harness({ myDay: false });
    expect(await h.exec(input)).toEqual(rejected("list_appearance_unavailable"));
    expect(h.groupCalls).toEqual([]);
  });

  it("names only the group itself; a neighbour may be a list", () => {
    expect(refsOf({ id: "m", at: "2026-11-25T00:00:00Z", op: "list_group.reorder", sid: G1, position: { before: sidOf("Lb") } })).toEqual([
      { kind: "list_group", sid: G1 },
    ]);
  });
});
