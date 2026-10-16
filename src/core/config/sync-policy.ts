import type { ListsConfig } from "./schemas";

// Well-known lists skipped from delta sync out of the box, independent of the
// user's no_sync setting. flaggedEmails is typically enormous (often the
// majority of a corpus) and not used as a task list, so indexing it wastes the
// free-tier daily rows-written budget and pollutes full-text search. Re-enabled
// ONLY by the explicit sync_flagged_emails opt-in — never by clearing no_sync.
export const BUILTIN_NO_SYNC_WELLKNOWN = ["flaggedEmails"] as const;

// Single source of truth for "should this list be excluded from delta sync?".
// Matched by wellknownListName OR Graph list id (never display name — too
// fragile). The built-in flaggedEmails skip is checked independently of no_sync
// so customizing no_sync for other lists can never accidentally re-enable
// flagged-email sync.
export function shouldSkipSync(
  list: { list_id: string; wellknown: string | null },
  cfg: ListsConfig,
): boolean {
  if (
    list.wellknown !== null &&
    (BUILTIN_NO_SYNC_WELLKNOWN as readonly string[]).includes(list.wellknown) &&
    !cfg.sync_flagged_emails
  ) {
    return true;
  }
  if (list.wellknown !== null && cfg.no_sync.includes(list.wellknown)) return true;
  if (cfg.no_sync.includes(list.list_id)) return true;
  return false;
}
