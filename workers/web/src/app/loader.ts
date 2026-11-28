// Loads the mirror: GET /sync/info for the owner's zone and the server's
// capabilities, then the change feed (docs/SYNC-API.md sections 4.1 and 14.1)
// through the engine's pullAll. The cursor is kept for incremental pulls.

import { type FetchPage, pullAll } from "../sync/pull.ts";
import type { FeedPage } from "../sync/feed.ts";
import type { MirrorStore } from "../sync/store.ts";
import type { BffFetch } from "./api.ts";
import { throttle } from "./throttle.ts";

/** Active scope: open tasks and recent completions. 1000 is the feed's largest page. */
const CHANGES = "sync/changes?scope=active&limit=1000";
const FOCUS_INTERVAL_MS = 30_000;

export interface ServerInfo {
  /** The IANA zone the feed's bare dates are in and "today" is computed in. */
  timezone: string;
  capabilities: Record<string, unknown>;
}

export interface Loader {
  /** /sync/info, then a full pull. Throws when either fails. */
  load(): Promise<void>;
  /** An incremental pull from the kept cursor; nothing before the first load. Concurrent calls share one pull. */
  reload(): Promise<void>;
  /** What /sync/info said, once loaded. */
  info(): ServerInfo | null;
  /** Today in the server's zone, as YYYY-MM-DD. */
  today(now?: Date): string;
}

/** The date `now` falls on in `timeZone`, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The FetchPage pullAll uses: the active-scope feed, mapping a cursor 410 to its 410 result. */
export function changesFetchPage(bffFetch: BffFetch): FetchPage {
  return async (cursor) => {
    const res = await bffFetch(cursor === null ? CHANGES : `${CHANGES}&${new URLSearchParams({ cursor })}`);
    if (res.ok) return { ok: true, page: (await res.json()) as FeedPage };
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (res.status === 410 && (body?.error === "cursor_reset" || body?.error === "cursor_expired")) {
      return { ok: false, status: 410, error: body.error };
    }
    throw new Error(`the change feed answered ${res.status}`);
  };
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function createLoader(bffFetch: BffFetch, store: MirrorStore): Loader {
  const fetchPage = changesFetchPage(bffFetch);
  let info: ServerInfo | null = null;
  let cursor: string | null = null;
  let reloading: Promise<void> | null = null;
  let warnedZone = false;

  async function readInfo(): Promise<ServerInfo> {
    const res = await bffFetch("sync/info");
    if (!res.ok) throw new Error(`/sync/info answered ${res.status}`);
    const body = (await res.json()) as { timezone?: unknown; capabilities?: unknown };
    let timezone = typeof body.timezone === "string" && body.timezone !== "" ? body.timezone : null;
    if (timezone === null) {
      // A server from before 0.19.1 doesn't send its zone.
      timezone = browserZone();
      if (!warnedZone) console.warn(`/sync/info has no timezone; using the browser's (${timezone})`);
      warnedZone = true;
    }
    const capabilities = typeof body.capabilities === "object" && body.capabilities !== null ? body.capabilities : {};
    return { timezone, capabilities: capabilities as Record<string, unknown> };
  }

  return {
    async load() {
      info = await readInfo();
      cursor = (await pullAll(fetchPage, store, null)).cursor;
    },

    reload() {
      if (cursor === null) return Promise.resolve();
      reloading ??= pullAll(fetchPage, store, cursor)
        .then((r) => {
          cursor = r.cursor;
        })
        .finally(() => {
          reloading = null;
        });
      return reloading;
    },

    info: () => info,

    today: (now = new Date()) => todayIn(info?.timezone ?? browserZone(), now),
  };
}

/**
 * Pulls new changes when the window gains focus, at most once every 30 s; the
 * load counts as the first. A failure is logged and the mirror kept. Returns a
 * function that stops watching.
 */
export function watchFocus(loader: Pick<Loader, "reload">, target: EventTarget): () => void {
  const onFocus = throttle(() => {
    loader.reload().catch((e: unknown) => console.warn("pull on focus failed", e));
  }, FOCUS_INTERVAL_MS);
  target.addEventListener("focus", onFocus);
  return () => target.removeEventListener("focus", onFocus);
}
