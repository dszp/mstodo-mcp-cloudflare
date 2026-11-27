import type { ListsConfig } from "./schemas";

const MAX_LIST_NAME_CHARS = 256;

// Strip emoji (Extended_Pictographic), skin-tone modifiers (Emoji_Modifier,
// U+1F3FB–U+1F3FF), variation selectors (U+FE0F), and Zero-Width Joiners
// (U+200D) from a display name, then trim whitespace. This normalizes names
// like "🏠HOME" to "HOME" before pattern matching.
//
// Emoji_Modifier is its own property — it is NOT Extended_Pictographic — so a
// name like "👨🏻 TEAM PROJECTS 👨🏻" left a stray "🏻" once the base glyph was
// removed, defeating anchored patterns. We deliberately do NOT use the broader
// Emoji_Component (which also covers ASCII digits, "#", "*") — that would
// mangle legitimate names like "30 GOALS".
export function stripEmoji(s: string): string {
  return s.replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍/gu, "").trim();
}

export type ListClass = "todo" | "reference" | "excluded";

// A list's one setting (docs/SYNC-API.md section 1.2): its class for the MCP
// tools and its sync behaviour for the mirror and the app.
//   todo      — mirrored at full speed, with a Graph subscription.
//   reference — mirrored on a slower cadence, no subscription.
//   excluded  — not mirrored; never in the sync feed.
// "unclassified" (nothing matched) syncs as todo.
//
// Precedence, first hit wins:
//   1. an ID pin in `overrides` (immune to renames; what set_list_config and
//      the app's list.update write);
//   2. the legacy `no_sync` (→ excluded) and `archive` (→ reference) arrays,
//      matched by Graph list ID or wellknownListName;
//   3. the built-in flaggedEmails default: excluded, or reference when
//      `sync_flagged_emails` is on;
//   4. name patterns, in order.
export function classifyList(
  displayName: string,
  config: ListsConfig,
  listId?: string,
  wellknown?: string | null,
): ListClass | "unclassified" {
  if (listId) {
    const pinned = config.overrides[listId];
    if (pinned) return pinned; // ID pin wins — survives renames
  }
  const named = (arr: string[]) =>
    (listId !== undefined && arr.includes(listId)) || (!!wellknown && arr.includes(wellknown));
  if (named(config.no_sync)) return "excluded";
  if (named(config.archive)) return "reference";
  if (wellknown === "flaggedEmails") return config.sync_flagged_emails ? "reference" : "excluded";
  return classifyByName(displayName, config);
}

// Name patterns only: the first match wins, "unclassified" if none.
export function classifyByName(displayName: string, config: ListsConfig): ListClass | "unclassified" {
  // Bound regex work: a To Do list name is short, so anything past this is noise.
  const normalized = stripEmoji(displayName).slice(0, MAX_LIST_NAME_CHARS);
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
  lists: { list_id: string; display_name: string | null; wellknown?: string | null }[],
  config: ListsConfig,
): { overrides: Record<string, ListClass>; added: number } {
  const unpinned = { ...config, overrides: {} };
  const overrides: Record<string, ListClass> = { ...config.overrides };
  let added = 0;
  for (const l of lists) {
    if (overrides[l.list_id]) continue; // already pinned — never overwrite
    // Pin only a class that came from a name pattern. A list the legacy arrays
    // or the flaggedEmails default decide stays unpinned, so those keep
    // deciding it (a pin would outrank them).
    const t = classifyByName(l.display_name ?? "", config);
    if (t !== "unclassified" && classifyList(l.display_name ?? "", unpinned, l.list_id, l.wellknown) === t) {
      overrides[l.list_id] = t;
      added += 1;
    }
  }
  return { overrides, added };
}
