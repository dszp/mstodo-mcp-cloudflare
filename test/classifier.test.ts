import { describe, it, expect } from "vitest";
import { stripEmoji, classifyList } from "../src/config/classifier";
import type { ListsConfig } from "../src/config/schemas";

const cfg = (patterns: ListsConfig["patterns"]): ListsConfig => ({
  patterns,
  aliases: {},
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
