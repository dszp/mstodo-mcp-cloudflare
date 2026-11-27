import { describe, it, expect } from "vitest";
import { resolveListId, type RosterEntry } from "@potem/core/config/aliases";
import type { ListsConfig } from "@potem/core/config/schemas";

const config = (aliases: Record<string, string>): ListsConfig => ({
  patterns: [],
  aliases,
  overrides: {},
  no_sync: [],
  archive: [], sync_flagged_emails: false,
});

const roster: RosterEntry[] = [
  { id: "id-home", displayName: "🏠HOME" },
  { id: "id-work", displayName: "Work" },
];

describe("resolveListId", () => {
  it("resolves an alias before consulting the roster", () => {
    expect(resolveListId("inbox", config({ inbox: "id-work" }), roster)).toBe("id-work");
  });

  it("matches a display name emoji-stripped and case-insensitively", () => {
    expect(resolveListId("home", config({}), roster)).toBe("id-home");
    expect(resolveListId("WORK", config({}), roster)).toBe("id-work");
  });

  it("passes through an unknown value (e.g. a raw Graph id)", () => {
    expect(resolveListId("AAMkraw==", config({}), roster)).toBe("AAMkraw==");
  });

  it("degrades to passthrough when the roster is empty (cold index)", () => {
    expect(resolveListId("home", config({}), [])).toBe("home");
  });
});
