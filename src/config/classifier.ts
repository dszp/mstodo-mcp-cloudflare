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

export type ListClass = "todo" | "reference" | "excluded";

// Classify a list. When `listId` is given and pinned in `config.overrides`, the
// pinned class wins (ID-based, immune to renames). Otherwise patterns are tested
// in order; the first match wins. Returns "unclassified" if nothing matches.
export function classifyList(
  displayName: string,
  config: ListsConfig,
  listId?: string,
): ListClass | "unclassified" {
  if (listId) {
    const pinned = config.overrides[listId];
    if (pinned) return pinned; // ID pin wins — survives renames
  }
  const normalized = stripEmoji(displayName);
  for (const p of config.patterns) {
    if (new RegExp(p.pattern, p.flags).test(normalized)) return p.type;
  }
  return "unclassified";
}

// Pin every roster list that a name pattern currently classifies (and that
// isn't already pinned) to its immutable Graph list ID, so a later rename can't
// silently change its class. Pure: returns the merged overrides map and how many
// new pins were added (0 ⇒ nothing to persist).
export function pinClassifications(
  lists: { list_id: string; display_name: string | null }[],
  config: ListsConfig,
): { overrides: Record<string, ListClass>; added: number } {
  const overrides: Record<string, ListClass> = { ...config.overrides };
  let added = 0;
  for (const l of lists) {
    if (overrides[l.list_id]) continue; // already pinned — never overwrite
    // Pattern-only classification (no listId) so we pin the name-derived class.
    const t = classifyList(l.display_name ?? "", config);
    if (t !== "unclassified") {
      overrides[l.list_id] = t;
      added += 1;
    }
  }
  return { overrides, added };
}
