import type { FeedPage } from "./feed";
import type { MirrorStore } from "./store";

// The caller owns the URL, scope and page size; this module never touches fetch.
export type FetchPage = (
  cursor: string | null,
) => Promise<
  { ok: true; page: FeedPage } | { ok: false; status: 410; error: "cursor_reset" | "cursor_expired" }
>;

// pages and changes count what the store holds now: a 410 restart clears the
// store, so the counts start over from zero.
export interface PullResult {
  cursor: string;
  pages: number;
  changes: number;
}

// Pages through the change feed into the store, one applyPage per page.
// A full sync (no cursor) carries no deletion records, so it clears the store
// before applying its first page, or rows the server deleted would linger. The
// clear waits for that page so a refused or failed request leaves the mirror
// as it was. A 410 means the cursor is unusable: the pull restarts as a full
// sync, at most once. A 410 after a restart, or when already pulling from
// null, has nowhere left to fall back to, so it throws.
export async function pullAll(
  fetchPage: FetchPage,
  store: MirrorStore,
  from: string | null,
  onPage?: (n: { pages: number; changes: number }) => void,
): Promise<PullResult> {
  let cursor = from;
  let pages = 0;
  let changes = 0;
  let restarted = false;
  let clearFirst = cursor === null;
  for (;;) {
    const res = await fetchPage(cursor);
    if (!res.ok) {
      if (restarted || cursor === null) throw new Error(`change feed refused a full sync: ${res.error}`);
      clearFirst = true;
      cursor = null;
      restarted = true;
      pages = 0;
      changes = 0;
      continue;
    }
    if (clearFirst) {
      store.clear();
      clearFirst = false;
    }
    store.applyPage(res.page.changes);
    pages += 1;
    changes += res.page.changes.length;
    cursor = res.page.cursor;
    onPage?.({ pages, changes });
    if (!res.page.has_more) return { cursor, pages, changes };
  }
}
