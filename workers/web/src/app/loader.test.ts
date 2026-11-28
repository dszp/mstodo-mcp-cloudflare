import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedChange, FeedPage } from "../sync/feed.ts";
import { MirrorStore } from "../sync/store.ts";
import type { BffFetch } from "./api.ts";
import { changesFetchPage, createLoader, todayIn, watchFocus } from "./loader.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const list = (id: string, name: string): FeedChange => ({
  kind: "list",
  id,
  seq: 1,
  deleted: false,
  data: { name } as never,
});
const page = (changes: FeedChange[], cursor: string, has_more = false): FeedPage => ({
  cursor,
  has_more,
  changes,
  backfill: { remaining: 0 },
});

/** A bffFetch stub: answers by path, records each path asked for. */
function stub(route: (path: string) => Response) {
  const paths: string[] = [];
  const fn: BffFetch = async (path) => {
    paths.push(path);
    return route(path);
  };
  return { fn, paths };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("todayIn", () => {
  it("is the date in the given zone, not UTC", () => {
    const now = new Date("2026-11-27T04:30:00Z");
    expect(todayIn("America/New_York", now)).toBe("2026-11-26");
    expect(todayIn("UTC", now)).toBe("2026-11-27");
    expect(todayIn("Asia/Tokyo", new Date("2026-12-31T15:00:00Z"))).toBe("2027-01-01");
  });
});

describe("changesFetchPage", () => {
  it("asks for scope=active&limit=1000, adding the cursor when there is one", async () => {
    const { fn, paths } = stub(() => json(page([], "7")));
    const fetchPage = changesFetchPage(fn);
    await fetchPage(null);
    await fetchPage("abc/+=");
    expect(paths).toEqual([
      "sync/changes?scope=active&limit=1000",
      "sync/changes?scope=active&limit=1000&cursor=abc%2F%2B%3D",
    ]);
  });

  it("returns the page", async () => {
    const p = page([list("l1", "Example")], "9");
    const { fn } = stub(() => json(p));
    expect(await changesFetchPage(fn)(null)).toEqual({ ok: true, page: p });
  });

  it.each(["cursor_reset", "cursor_expired"] as const)("maps 410 %s to the FetchPage 410 shape", async (error) => {
    const { fn } = stub(() => json({ error }, 410));
    expect(await changesFetchPage(fn)("5")).toEqual({ ok: false, status: 410, error });
  });

  it("throws on a 410 with another body, and on any other failure", async () => {
    await expect(changesFetchPage(stub(() => json({ error: "gone" }, 410)).fn)("5")).rejects.toThrow();
    await expect(changesFetchPage(stub(() => json({ error: "x" }, 502)).fn)("5")).rejects.toThrow();
    await expect(changesFetchPage(stub(() => json({ error: "x" }, 400)).fn)(null)).rejects.toThrow();
  });
});

describe("createLoader", () => {
  const capabilities = { my_day: true, push: "websocket" };

  function server() {
    const feed: FeedPage[] = [page([list("l1", "One")], "1", true), page([list("l2", "Two")], "2")];
    return stub((path) => {
      if (path === "sync/info") return json({ server_id: "s", timezone: "America/New_York", capabilities });
      const cursor = new URLSearchParams(path.split("?")[1]).get("cursor");
      if (cursor === null) return json(feed[0]);
      if (cursor === "1") return json(feed[1]);
      return json(page([list("l3", "Three")], "3"));
    });
  }

  it("reads /sync/info first, then pulls every page into the store", async () => {
    const { fn, paths } = server();
    const store = new MirrorStore();
    const loader = createLoader(fn, store);
    await loader.load();
    expect(paths).toEqual([
      "sync/info",
      "sync/changes?scope=active&limit=1000",
      "sync/changes?scope=active&limit=1000&cursor=1",
    ]);
    expect(store.lists().map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(loader.info()).toEqual({ timezone: "America/New_York", capabilities });
  });

  it("computes today in the server's zone", async () => {
    const loader = createLoader(server().fn, new MirrorStore());
    await loader.load();
    expect(loader.today(new Date("2026-11-27T04:30:00Z"))).toBe("2026-11-26");
  });

  it("falls back to the browser's zone when /sync/info has no timezone, and logs once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fn } = stub((path) =>
      path === "sync/info" ? json({ server_id: "s", capabilities: {} }) : json(page([], "1")),
    );
    const loader = createLoader(fn, new MirrorStore());
    await loader.load();
    await loader.load();
    expect(loader.info()?.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("throws when /sync/info fails", async () => {
    const loader = createLoader(stub(() => json({ error: "x" }, 502)).fn, new MirrorStore());
    await expect(loader.load()).rejects.toThrow();
  });

  it("reload() pulls incrementally from the kept cursor", async () => {
    const { fn, paths } = server();
    const store = new MirrorStore();
    const loader = createLoader(fn, store);
    await loader.load();
    paths.length = 0;
    await loader.reload();
    expect(paths).toEqual(["sync/changes?scope=active&limit=1000&cursor=2"]);
    expect(store.lists().map((l) => l.id)).toEqual(["l1", "l2", "l3"]);
  });

  it("reload() before a load does nothing", async () => {
    const { fn, paths } = server();
    await createLoader(fn, new MirrorStore()).reload();
    expect(paths).toEqual([]);
  });

  it("concurrent reloads share one pull", async () => {
    const { fn, paths } = server();
    const loader = createLoader(fn, new MirrorStore());
    await loader.load();
    paths.length = 0;
    await Promise.all([loader.reload(), loader.reload()]);
    expect(paths).toHaveLength(1);
  });
});

describe("watchFocus", () => {
  it("reloads on focus at most once every 30 s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
    const target = new EventTarget();
    const reload = vi.fn(async () => {});
    const stop = watchFocus({ reload }, target);
    target.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(30_000);
    target.dispatchEvent(new Event("focus"));
    target.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    stop();
    target.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
