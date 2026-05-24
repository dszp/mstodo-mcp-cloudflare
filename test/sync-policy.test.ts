import { describe, it, expect } from "vitest";
import { shouldSkipSync, BUILTIN_NO_SYNC_WELLKNOWN } from "../src/config/sync-policy";
import { ListsConfigSchema } from "../src/config/schemas";

const cfg = (over: Partial<{ no_sync: string[]; sync_flagged_emails: boolean }> = {}) =>
  ListsConfigSchema.parse({ patterns: [], aliases: {}, ...over });

describe("shouldSkipSync", () => {
  it("exposes flaggedEmails as a built-in no-sync wellknown", () => {
    expect(BUILTIN_NO_SYNC_WELLKNOWN).toContain("flaggedEmails");
  });

  it("skips flaggedEmails by default", () => {
    expect(shouldSkipSync({ list_id: "L1", wellknown: "flaggedEmails" }, cfg())).toBe(true);
  });

  it("indexes flaggedEmails when sync_flagged_emails is true", () => {
    expect(
      shouldSkipSync({ list_id: "L1", wellknown: "flaggedEmails" }, cfg({ sync_flagged_emails: true })),
    ).toBe(false);
  });

  it("keeps flaggedEmails skipped even when no_sync is customized for other lists", () => {
    expect(
      shouldSkipSync({ list_id: "L1", wellknown: "flaggedEmails" }, cfg({ no_sync: ["someOtherList"] })),
    ).toBe(true);
  });

  it("skips a list whose wellknown is in no_sync", () => {
    expect(shouldSkipSync({ list_id: "L2", wellknown: "defaultList" }, cfg({ no_sync: ["defaultList"] }))).toBe(true);
  });

  it("skips a list whose Graph id is in no_sync", () => {
    expect(shouldSkipSync({ list_id: "L3", wellknown: null }, cfg({ no_sync: ["L3"] }))).toBe(true);
  });

  it("does not skip an ordinary list with no match", () => {
    expect(shouldSkipSync({ list_id: "L4", wellknown: "none" }, cfg())).toBe(false);
    expect(shouldSkipSync({ list_id: "L5", wellknown: null }, cfg())).toBe(false);
  });

  // Contradictory user state: opt in to flagged sync AND explicitly exclude it.
  // Explicit no_sync wins (exclusion is the safe, write-conserving resolution).
  it("explicit no_sync entry wins over sync_flagged_emails opt-in", () => {
    expect(
      shouldSkipSync(
        { list_id: "L1", wellknown: "flaggedEmails" },
        cfg({ no_sync: ["flaggedEmails"], sync_flagged_emails: true }),
      ),
    ).toBe(true);
  });
});
