import { describe, it, expect } from "vitest";
import { resolveListId, type RosterEntry } from "../src/config/aliases";
import type { ListsConfig } from "../src/config/schemas";

const config = (aliases: Record<string, string>): ListsConfig => ({
  patterns: [],
  aliases,
  no_sync: [],
  sync_flagged_emails: false,
});

const roster: RosterEntry[] = [
  { id: "id-personal", displayName: "🏠PERSONAL" },
  { id: "id-work", displayName: "Work" },
];

describe("resolveListId", () => {
  it("resolves an alias before consulting the roster", () => {
    expect(resolveListId("inbox", config({ inbox: "id-work" }), roster)).toBe("id-work");
  });

  it("matches a display name emoji-stripped and case-insensitively", () => {
    expect(resolveListId("personal", config({}), roster)).toBe("id-personal");
    expect(resolveListId("WORK", config({}), roster)).toBe("id-work");
  });

  it("passes through an unknown value (e.g. a raw Graph id)", () => {
    expect(resolveListId("AAMkraw==", config({}), roster)).toBe("AAMkraw==");
  });

  it("degrades to passthrough when the roster is empty (cold index)", () => {
    expect(resolveListId("personal", config({}), [])).toBe("personal");
  });
});
