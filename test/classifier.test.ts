import { describe, it, expect } from "vitest";
import { stripEmoji, classifyList, pinClassifications } from "../src/config/classifier";
import type { ListsConfig } from "../src/config/schemas";

const cfg = (
  patterns: ListsConfig["patterns"],
  overrides: ListsConfig["overrides"] = {},
): ListsConfig => ({
  patterns,
  aliases: {},
  overrides,
  no_sync: [],
  sync_flagged_emails: false,
});

describe("stripEmoji", () => {
  it("strips a plain Extended_Pictographic emoji and trims", () => {
    expect(stripEmoji("🏠PERSONAL")).toBe("PERSONAL");
    expect(stripEmoji("MY TEAM 👥")).toBe("MY TEAM");
  });

  it("strips Fitzpatrick skin-tone modifiers attached to an emoji (the bug)", () => {
    // 👨🏻 = man (U+1F468, Extended_Pictographic) + light skin tone (U+1F3FB,
    // Emoji_Modifier). The base was stripped but the modifier survived,
    // leaving a leading "🏻" that defeated anchored patterns.
    expect(stripEmoji("👨🏻 INTERNAL TECH 👨🏻")).toBe("INTERNAL TECH");
    expect(stripEmoji("👨🏻 n8n COMMUNITY NODES 👨🏻")).toBe("n8n COMMUNITY NODES");
  });

  it("strips a skin-tone modifier inside a ZWJ sequence", () => {
    // 👨🏻‍💻 = man + skin tone + ZWJ + laptop
    expect(stripEmoji("👨🏻‍💻 DEVOPS")).toBe("DEVOPS");
  });

  it("does NOT strip ASCII digits (would break names like '90 ROCKS')", () => {
    expect(stripEmoji("90 ROCKS")).toBe("90 ROCKS");
    expect(stripEmoji("📅 90 ROCKS")).toBe("90 ROCKS");
  });
});

describe("classifyList", () => {
  const patterns = [{ pattern: "^INTERNAL TECH$", flags: "i", type: "todo" as const }];

  it("classifies a skin-tone-bookended name that previously fell through", () => {
    expect(classifyList("👨🏻 INTERNAL TECH 👨🏻", cfg(patterns))).toBe("todo");
  });

  it("returns unclassified when no pattern matches", () => {
    expect(classifyList("RANDOM LIST", cfg(patterns))).toBe("unclassified");
  });
});

describe("classifyList — ID overrides (pinned)", () => {
  const patterns = [{ pattern: "^WORK$", flags: "i", type: "todo" as const }];

  it("an ID override wins over a matching name pattern", () => {
    const config = cfg(patterns, { "list-1": "reference" });
    expect(classifyList("WORK", config, "list-1")).toBe("reference");
  });

  it("an ID override applies regardless of the display name (rename-immune)", () => {
    const config = cfg([], { "list-1": "reference" });
    expect(classifyList("SOME BRAND NEW NAME", config, "list-1")).toBe("reference");
  });

  it("falls back to name patterns when the id is not pinned", () => {
    const config = cfg(patterns, { "list-1": "reference" });
    expect(classifyList("WORK", config, "list-2")).toBe("todo");
  });
});

describe("pinClassifications", () => {
  const patterns = [
    { pattern: "^WORK$", flags: "i", type: "todo" as const },
    { pattern: "^ARCHIVE$", flags: "i", type: "reference" as const },
  ];

  it("pins each name-matched list to its id; leaves unmatched lists unpinned", () => {
    const lists = [
      { list_id: "id-w", display_name: "WORK" },
      { list_id: "id-a", display_name: "ARCHIVE" },
      { list_id: "id-x", display_name: "RANDOM" },
    ];
    const { overrides, added } = pinClassifications(lists, cfg(patterns));
    expect(added).toBe(2);
    expect(overrides).toEqual({ "id-w": "todo", "id-a": "reference" });
  });

  it("never overwrites an existing pin (a user-set class survives a name change)", () => {
    const config = cfg(patterns, { "id-w": "excluded" });
    const lists = [{ list_id: "id-w", display_name: "WORK" }]; // pattern says todo
    const { overrides, added } = pinClassifications(lists, config);
    expect(added).toBe(0);
    expect(overrides["id-w"]).toBe("excluded");
  });

  it("is idempotent: a second pass over the same roster adds nothing", () => {
    const lists = [{ list_id: "id-w", display_name: "WORK" }];
    const first = pinClassifications(lists, cfg(patterns));
    const second = pinClassifications(lists, cfg(patterns, first.overrides));
    expect(second.added).toBe(0);
  });
});
