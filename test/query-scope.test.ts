import { describe, it, expect } from "vitest";
import { resolveStatusFilter, resolveListScope, OPEN_STATUSES } from "../src/config/query-scope";
import { ListsConfigSchema, type ListsConfig } from "../src/config/schemas";

const cfg: ListsConfig = ListsConfigSchema.parse({
  patterns: [
    { pattern: "work", flags: "i", type: "todo" },
    { pattern: "ref", flags: "i", type: "reference" },
    { pattern: "flagged", flags: "i", type: "excluded" },
  ],
  aliases: {},
});

const roster = [
  { list_id: "A", display_name: "Work" }, // todo
  { list_id: "B", display_name: "Reference" }, // reference
  { list_id: "C", display_name: "Flagged" }, // excluded
  { list_id: "D", display_name: "Misc" }, // unclassified
];

describe("resolveStatusFilter", () => {
  it("returns undefined status when neither status nor completed given", () => {
    expect(resolveStatusFilter(undefined, undefined)).toEqual({ ok: true, status: undefined });
  });
  it("maps completed:true to ['completed']", () => {
    expect(resolveStatusFilter(undefined, true)).toEqual({ ok: true, status: ["completed"] });
  });
  it("maps completed:false to the open set", () => {
    expect(resolveStatusFilter(undefined, false)).toEqual({ ok: true, status: [...OPEN_STATUSES] });
  });
  it("dedupes an explicit status array", () => {
    expect(resolveStatusFilter(["notStarted", "notStarted", "completed"], undefined)).toEqual({
      ok: true,
      status: ["notStarted", "completed"],
    });
  });
  it("accepts a single status string", () => {
    expect(resolveStatusFilter("inProgress", undefined)).toEqual({ ok: true, status: ["inProgress"] });
  });
  it("errors when both status and completed are supplied", () => {
    expect(resolveStatusFilter("completed", true)).toEqual({ ok: false, error: "conflicting_status_filter" });
    expect(resolveStatusFilter(["notStarted"], false)).toEqual({ ok: false, error: "conflicting_status_filter" });
  });
});

describe("resolveListScope", () => {
  it("returns undefined (no filter) when no lists/types/exclude_types", () => {
    expect(resolveListScope({ roster, config: cfg })).toBeUndefined();
  });
  it("include-only: keeps ids whose classification is in types", () => {
    expect(resolveListScope({ roster, config: cfg, types: ["todo"] })).toEqual(["A"]);
  });
  it("exclude-only: drops ids whose classification is in exclude_types", () => {
    expect(resolveListScope({ roster, config: cfg, exclude_types: ["excluded"] })).toEqual(["A", "B", "D"]);
  });
  it("both: exclude wins on overlap", () => {
    expect(
      resolveListScope({ roster, config: cfg, types: ["todo", "excluded"], exclude_types: ["excluded"] }),
    ).toEqual(["A"]);
  });
  it("intersects with an explicit resolved lists set", () => {
    expect(resolveListScope({ roster, config: cfg, lists: ["A", "C"], exclude_types: ["excluded"] })).toEqual(["A"]);
  });
  it("empty types array is treated as no include-filter", () => {
    expect(resolveListScope({ roster, config: cfg, types: [] })).toBeUndefined();
  });
  it("empty resolved set yields an empty array (not undefined)", () => {
    expect(resolveListScope({ roster, config: cfg, types: ["reference"], exclude_types: ["reference"] })).toEqual([]);
  });
  it("explicit lists alone passes through without classification filtering", () => {
    expect(resolveListScope({ roster, config: cfg, lists: ["A", "B"] })).toEqual(["A", "B"]);
  });
  it("ids in lists but absent from the roster classify as unclassified", () => {
    expect(resolveListScope({ roster, config: cfg, lists: ["Z"], types: ["unclassified"] })).toEqual(["Z"]);
  });
  it("empty lists array is treated as no filter (undefined), matching types/exclude_types", () => {
    expect(resolveListScope({ roster, config: cfg, lists: [] })).toBeUndefined();
  });
});
