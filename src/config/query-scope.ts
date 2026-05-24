import { classifyList } from "./classifier";
import type { ListsConfig } from "./schemas";

export type Classification = "todo" | "reference" | "excluded" | "unclassified";

// The open (non-completed) Graph task statuses. completed:false expands to these.
export const OPEN_STATUSES = ["notStarted", "inProgress", "waitingOnOthers", "deferred"] as const;

// Resolve the effective status filter from the mutually-exclusive `status` and
// `completed` params. `completed` is a convenience: true -> completed only;
// false -> the open set. Supplying both is a hard error (no silent precedence).
export function resolveStatusFilter(
  status: string | string[] | undefined,
  completed: boolean | undefined,
):
  | { ok: true; status: string[] | undefined }
  | { ok: false; error: "conflicting_status_filter" } {
  if (status !== undefined && completed !== undefined) {
    return { ok: false, error: "conflicting_status_filter" };
  }
  if (completed === true) return { ok: true, status: ["completed"] };
  if (completed === false) return { ok: true, status: [...OPEN_STATUSES] };
  if (status === undefined) return { ok: true, status: undefined };
  return { ok: true, status: [...new Set(Array.isArray(status) ? status : [status])] };
}

// Resolve the effective list-id allowlist from classification include/exclude
// filters over the roster, intersected with any explicit (already-resolved)
// `lists`. Returns undefined when NO filter applies (lists/types/exclude_types
// all absent or empty arrays) — callers pass undefined straight through,
// preserving today's "all lists" behavior. When a filter IS supplied but
// matches nothing, returns an empty array (empty results, not an error).
export function resolveListScope(input: {
  roster: { list_id: string; display_name: string | null }[];
  config: ListsConfig;
  lists?: string[];
  types?: Classification[];
  exclude_types?: Classification[];
}): string[] | undefined {
  const { roster, config } = input;
  // Normalize all three to undefined when empty so "no restriction" is a single,
  // symmetric contract (an empty `lists` is treated as absent, like the type
  // filters — never as "match nothing").
  const lists = input.lists && input.lists.length > 0 ? input.lists : undefined;
  const types = input.types && input.types.length > 0 ? input.types : undefined;
  const exclude_types =
    input.exclude_types && input.exclude_types.length > 0 ? input.exclude_types : undefined;

  if (!lists && !types && !exclude_types) return undefined;

  const classOf = new Map<string, Classification>(
    roster.map((l) => [l.list_id, classifyList(l.display_name ?? "", config)]),
  );
  // Ids in an explicit `lists` but absent from the roster (passthrough Graph
  // ids) classify as "unclassified".
  const classify = (id: string): Classification => classOf.get(id) ?? "unclassified";

  let ids = lists ?? roster.map((l) => l.list_id);
  if (types) ids = ids.filter((id) => types.includes(classify(id)));
  if (exclude_types) ids = ids.filter((id) => !exclude_types.includes(classify(id)));
  return ids;
}
