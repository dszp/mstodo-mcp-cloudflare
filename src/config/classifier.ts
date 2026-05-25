import type { ListsConfig } from "./schemas";

// Strip emoji (Extended_Pictographic), skin-tone modifiers (Emoji_Modifier,
// U+1F3FB–U+1F3FF), variation selectors (U+FE0F), and Zero-Width Joiners
// (U+200D) from a display name, then trim whitespace. This normalizes names
// like "🏠PERSONAL" to "PERSONAL" before pattern matching.
//
// Emoji_Modifier is its own property — it is NOT Extended_Pictographic — so a
// name like "👨🏻 INTERNAL TECH 👨🏻" left a stray "🏻" once the base glyph was
// removed, defeating anchored patterns. We deliberately do NOT use the broader
// Emoji_Component (which also covers ASCII digits, "#", "*") — that would
// mangle legitimate names like "90 ROCKS".
export function stripEmoji(s: string): string {
  return s.replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍/gu, "").trim();
}

// Classify a list by its display name against the configured pattern list.
// Patterns are tested in order; the first match wins. Returns "unclassified"
// if no pattern matches.
export function classifyList(
  displayName: string,
  config: ListsConfig,
): "todo" | "reference" | "excluded" | "unclassified" {
  const normalized = stripEmoji(displayName);
  for (const p of config.patterns) {
    if (new RegExp(p.pattern, p.flags).test(normalized)) return p.type;
  }
  return "unclassified";
}
