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

// One change to config:lists, as data so it can cross Durable Object RPC: the
// index applies it to the newest config it knows (IndexCore.updateListsConfig).
// `patterns` and `no_sync` replace; `overrides` and `aliases` merge per key,
// with null removing that key, so a caller holding an old copy of the map
// changes only the keys it names.
export interface ListsConfigChange {
  patterns?: ListsConfig["patterns"];
  overrides?: Record<string, ListSync | null>;
  no_sync?: string[];
  sync_flagged_emails?: boolean;
  aliases?: Record<string, string | null>;
  clear_aliases?: boolean;
}

// Pure. A pin also drops its list ID from the legacy arrays (withListSync), so
// removing the pin later leaves the list to patterns rather than to a stale
// legacy entry. Applied after `no_sync`, so a pin in the same change wins.
export function applyListsConfigChange(cfg: ListsConfig, change: ListsConfigChange): ListsConfig {
  let next: ListsConfig = {
    ...cfg,
    patterns: change.patterns ?? cfg.patterns,
    no_sync: change.no_sync ?? cfg.no_sync,
    sync_flagged_emails: change.sync_flagged_emails ?? cfg.sync_flagged_emails,
    aliases: change.clear_aliases ? {} : { ...cfg.aliases },
    overrides: { ...cfg.overrides },
  };
  for (const [alias, id] of Object.entries(change.aliases ?? {})) {
    if (id === null) delete next.aliases[alias];
    else next.aliases[alias] = id;
  }
  for (const [listId, sync] of Object.entries(change.overrides ?? {})) {
    if (sync === null) delete next.overrides[listId];
    else next = withListSync(next, listId, sync);
  }
  return next;
}
