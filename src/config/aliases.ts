import { stripEmoji } from "./classifier";
import type { ListsConfig } from "./schemas";

// Minimal roster shape needed for display-name resolution. Callers pass the
// current list roster (sourced from the TodoIndex DO); this keeps resolveListId
// pure — no I/O, no env, easy to unit-test.
export interface RosterEntry {
  id: string;
  displayName?: string | null;
}

// Resolve a caller-supplied list identifier to a canonical Graph list ID.
//
// Resolution order:
//   1. Alias map — exact match on alias key (case-sensitive). No roster needed.
//      Example: "inbox" -> Graph list ID stored by set_list_alias.
//   2. Display-name match — emoji-stripped, case-insensitive comparison against
//      the supplied roster. Empty roster (cold index) simply skips this step.
//      Example: "PERSONAL" matches "🏠PERSONAL".
//   3. Raw passthrough — returns the input unchanged. Lets callers who already
//      hold a Graph list ID skip resolution; an invalid value surfaces as a
//      Graph 404 at call time.
export function resolveListId(
  input: string,
  config: ListsConfig,
  roster: RosterEntry[],
): string {
  const fromAlias = config.aliases[input];
  if (fromAlias !== undefined) return fromAlias;

  const needle = stripEmoji(input).toLowerCase();
  const match = roster.find(
    (l) => stripEmoji(l.displayName ?? "").toLowerCase() === needle,
  );
  if (match) return match.id;

  return input;
}
