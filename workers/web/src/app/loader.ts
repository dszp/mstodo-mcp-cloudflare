// Loads the mirror: GET /sync/info for the owner's zone and the server's
// capabilities, then the change feed (docs/SYNC-API.md sections 4.1 and 14.1)
// through the engine's pullAll. The cursor is kept for incremental pulls.

import { type FetchPage, pullAll } from "../sync/pull.ts";
import type { FeedPage } from "../sync/feed.ts";
import type { MirrorStore } from "../sync/store.ts";
import { type BffFetch, SignedOutError } from "./api.ts";
import type { SessionClient } from "./session.ts";
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
  /**
   * An incremental pull that starts after this call: it waits out a pull
   * already in flight (whether it succeeds or not), then pulls again. The
   * outbox uses it once the server has answered a batch, since a pull that
   * began before the answer may predate the server's write.
   */
  pullAfter(): Promise<void>;
  /** What /sync/info said, once loaded. */
  info(): ServerInfo | null;
  /** Today in the server's zone, as YYYY-MM-DD. */
  today(now?: Date): string;
}

/** Whether My Day can be edited: on unless /sync/info says capabilities.my_day is false. */
export function myDayOn(info: ServerInfo | null): boolean {
  return info?.capabilities["my_day"] !== false;
}

/** The date `now` falls on in `timeZone`, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The FetchPage pullAll uses: the active-scope feed, mapping a cursor 410 to its 410 result. */
export function changesFetchPage(bffFetch: BffFetch, session: Pick<SessionClient, "signedOut">): FetchPage {
  return async (cursor) => {
    const res = await bffFetch(cursor === null ? CHANGES : `${CHANGES}&${new URLSearchParams({ cursor })}`);
    if (res.ok) {
      const page = (await res.json()) as FeedPage;
      // bffFetch checked when the headers arrived; the session can end while
      // the body is read. The sealed store would drop the page anyway; this
      // stops the pull too.
      if (session.signedOut) throw new SignedOutError();
      return { ok: true, page };
    }
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (res.status === 410 && (body?.error === "cursor_reset" || body?.error === "cursor_expired")) {
      return { ok: false, status: 410, error: body.error };
    }
    throw new Error(`the change feed answered ${res.status}`);
  };
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function isZone(timeZone: string): boolean {
  if (timeZone === "") return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function createLoader(bffFetch: BffFetch, store: MirrorStore, session: Pick<SessionClient, "signedOut">): Loader {
  const fetchPage = changesFetchPage(bffFetch, session);
  let info: ServerInfo | null = null;
  let cursor: string | null = null;
  let reloading: Promise<void> | null = null;
  let warnedZone = false;

  async function readInfo(): Promise<ServerInfo> {
    const res = await bffFetch("sync/info");
    if (!res.ok) throw new Error(`/sync/info answered ${res.status}`);
    const body = (await res.json()) as { timezone?: unknown; capabilities?: unknown };
    let timezone = typeof body.timezone === "string" && isZone(body.timezone) ? body.timezone : null;
    if (timezone === null) {
      // A server from before 0.19.1 doesn't send its zone; a zone Intl doesn't
      // know would throw on every "today".
      timezone = browserZone();
      if (!warnedZone) console.warn(`/sync/info has no usable timezone; using the browser's (${timezone})`);
      warnedZone = true;
    }
    const capabilities = typeof body.capabilities === "object" && body.capabilities !== null ? body.capabilities : {};
    return { timezone, capabilities: capabilities as Record<string, unknown> };
  }

  function reload(): Promise<void> {
    if (cursor === null) return Promise.resolve();
    reloading ??= pullAll(fetchPage, store, cursor)
      .then((r) => {
        cursor = r.cursor;
      })
      .finally(() => {
        reloading = null;
      });
    return reloading;
  }

  return {
    async load() {
      info = await readInfo();
      cursor = (await pullAll(fetchPage, store, null)).cursor;
    },

    reload,

    pullAfter() {
      const prior = reloading;
      if (prior === null) return reload();
      // `reloading` is cleared before `prior` settles, so this starts a new
      // pull, or joins one another caller started after `prior` ended.
      return prior.then(reload, reload);
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

/** How often a visible page pulls on its own while the push socket isn't open (live.ts). */
const POLL_INTERVAL_MS = 30_000;

/**
 * Pulls every 30 s while the page is visible, so a change made elsewhere (the
 * Mac or iPhone app) shows up without a focus change or an edit here. A
 * hidden page doesn't pull; when it's shown again it pulls at once if 30 s or
 * more have passed since the last pull, otherwise when the 30 s are up. The
 * page has just pulled when this starts, so the first pull is 30 s later.
 * An idle incremental pull is one small request, cheap at any mirror size.
 * watchLive (live.ts) starts it while the push socket isn't open and stops it
 * while it is.
 */
export function watchVisiblePoll(
  loader: Pick<Loader, "reload">,
  doc: EventTarget & { visibilityState: string },
): () => void {
  let last = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pull = () => {
    last = Date.now();
    loader.reload().catch((e: unknown) => console.warn("periodic pull failed", e));
    timer = setTimeout(pull, POLL_INTERVAL_MS);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (doc.visibilityState !== "visible") return;
    const wait = last + POLL_INTERVAL_MS - Date.now();
    if (wait <= 0) pull();
    else timer = setTimeout(pull, wait);
  };

  doc.addEventListener("visibilitychange", schedule);
  schedule();
  return () => {
    doc.removeEventListener("visibilitychange", schedule);
    clearTimeout(timer);
  };
}
