import type { ListsConfig } from "./schemas";

// Strip emoji (Extended_Pictographic), variation selectors (U+FE0F), and
// Zero-Width Joiners (U+200D) from a display name, then trim whitespace.
// This normalizes names like "🏠PERSONAL" to "PERSONAL" before pattern matching.
export function stripEmoji(s: string): string {
  return s.replace(/\p{Extended_Pictographic}|️|‍/gu, "").trim();
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
