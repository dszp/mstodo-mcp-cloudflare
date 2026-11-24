import { describe, it, expect } from "vitest";
import { isArchiveList, listSync, shouldSkipSync, withListSync } from "../src/core/config/sync-policy";
import { pinClassifications } from "../src/core/config/classifier";
import { ListsConfigSchema } from "../src/core/config/schemas";

const cfg = (over: Record<string, unknown> = {}) => ListsConfigSchema.parse({ patterns: [], aliases: {}, ...over });
const flagged = { list_id: "L1", wellknown: "flaggedEmails" };

describe("listSync (docs/SYNC-API.md section 1.2)", () => {
  it("an unclassified list syncs as todo", () => {
    expect(listSync({ list_id: "L4", wellknown: "none" }, cfg())).toBe("todo");
    expect(listSync({ list_id: "L5", wellknown: null, display_name: "Groceries" }, cfg())).toBe("todo");
  });

  it("a name pattern sets the setting", () => {
    const c = cfg({ patterns: [{ pattern: "^ARCHIVE", type: "reference" }, { pattern: "^JUNK", type: "excluded" }] });
    expect(listSync({ list_id: "A", wellknown: null, display_name: "🗄️ARCHIVE 2024" }, c)).toBe("reference");
    expect(listSync({ list_id: "B", wellknown: null, display_name: "JUNK" }, c)).toBe("excluded");
  });

  it("an override pin wins over everything", () => {
    const c = cfg({
      patterns: [{ pattern: ".*", type: "excluded" }],
      no_sync: ["L1", "flaggedEmails"],
      overrides: { L1: "reference" },
    });
    expect(listSync(flagged, c)).toBe("reference");
  });

  it("legacy no_sync and archive apply by id or wellknown, above patterns", () => {
    const c = cfg({ patterns: [{ pattern: ".*", type: "todo" }], no_sync: ["defaultList"], archive: ["L3"] });
    expect(listSync({ list_id: "L2", wellknown: "defaultList", display_name: "Tasks" }, c)).toBe("excluded");
    expect(listSync({ list_id: "L3", wellknown: null, display_name: "Old" }, c)).toBe("reference");
  });

  it("flaggedEmails defaults to excluded, or reference with sync_flagged_emails", () => {
    expect(listSync(flagged, cfg())).toBe("excluded");
    expect(listSync(flagged, cfg({ sync_flagged_emails: true }))).toBe("reference");
  });

  it("explicit no_sync of flaggedEmails wins over sync_flagged_emails", () => {
    expect(shouldSkipSync(flagged, cfg({ no_sync: ["flaggedEmails"], sync_flagged_emails: true }))).toBe(true);
  });

  it("shouldSkipSync and isArchiveList read the one setting", () => {
    const c = cfg({ overrides: { A: "excluded", B: "reference", C: "todo" } });
    const l = (id: string) => ({ list_id: id, wellknown: null });
    expect([shouldSkipSync(l("A"), c), shouldSkipSync(l("B"), c), shouldSkipSync(l("C"), c)]).toEqual([true, false, false]);
    expect([isArchiveList(l("A"), c), isArchiveList(l("B"), c), isArchiveList(l("C"), c)]).toEqual([false, true, false]);
  });

  it("withListSync pins the list and drops it from the legacy arrays", () => {
    const c = withListSync(cfg({ no_sync: ["L9", "flaggedEmails"], archive: ["L9"] }), "L9", "todo");
    expect(c.overrides.L9).toBe("todo");
    expect(c.no_sync).toEqual(["flaggedEmails"]);
    expect(c.archive).toEqual([]);
  });
});

describe("pinClassifications", () => {
  it("does not pin a list the legacy arrays or the flaggedEmails default decide", () => {
    const c = cfg({ patterns: [{ pattern: ".*", type: "todo" }], no_sync: ["L2"] });
    const { overrides } = pinClassifications(
      [
        { list_id: "L1", display_name: "Flagged Emails", wellknown: "flaggedEmails" },
        { list_id: "L2", display_name: "Old", wellknown: null },
        { list_id: "L3", display_name: "Work", wellknown: null },
      ],
      c,
    );
    expect(overrides).toEqual({ L3: "todo" });
  });
});
