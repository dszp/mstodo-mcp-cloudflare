import { classifyList } from "./classifier";
import type { ListsConfig } from "./schemas";

// A list's sync setting (docs/SYNC-API.md section 1.2). It is the list's
// classification (classifier.ts), with "unclassified" syncing as todo, so the
// MCP tools, the mirror and the app all read one setting.
export type ListSync = "todo" | "reference" | "excluded";
export const LIST_SYNC_VALUES = ["todo", "reference", "excluded"] as const;

export type PolicyList = { list_id: string; wellknown: string | null; display_name?: string | null };

export function listSync(list: PolicyList, cfg: ListsConfig): ListSync {
  const c = classifyList(list.display_name ?? "", cfg, list.list_id, list.wellknown);
  return c === "unclassified" ? "todo" : c;
}

// Reference lists: mirrored after every todo list in each cycle, with no Graph
// subscription, and scanned for steps/links/attachments on open tasks only.
// (Flagged email gets no such scan at all; see #runChecklistScanBatch.)
export function isArchiveList(list: PolicyList, cfg: ListsConfig): boolean {
  return listSync(list, cfg) === "reference";
}

// Single source of truth for "should this list be left out of the mirror?".
// An excluded list keeps its roster row (list_lists still shows it and its
// tasks stay readable live from Graph), but its tasks aren't mirrored and the
// sync feed never carries it.
export function shouldSkipSync(list: PolicyList, cfg: ListsConfig): boolean {
  return listSync(list, cfg) === "excluded";
}

// Set one list's setting: pin it by Graph list ID and drop the ID from the
// legacy arrays, so the pin is the only thing deciding it. Pure.
export function withListSync(cfg: ListsConfig, listId: string, sync: ListSync): ListsConfig {
  return {
    ...cfg,
    overrides: { ...cfg.overrides, [listId]: sync },
    no_sync: cfg.no_sync.filter((x) => x !== listId),
    archive: cfg.archive.filter((x) => x !== listId),
  };
}
