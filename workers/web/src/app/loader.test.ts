import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedChange, FeedPage } from "../sync/feed.ts";
import { MirrorStore } from "../sync/store.ts";
import { type BffFetch, SignedOutError, createBffFetch } from "./api.ts";
import { createSessionClient } from "./session.ts";
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

/** A session that stays signed in. */
const LIVE = { signedOut: false };

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
    const fetchPage = changesFetchPage(fn, LIVE);
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
    expect(await changesFetchPage(fn, LIVE)(null)).toEqual({ ok: true, page: p });
  });

  it.each(["cursor_reset", "cursor_expired"] as const)("maps 410 %s to the FetchPage 410 shape", async (error) => {
    const { fn } = stub(() => json({ error }, 410));
    expect(await changesFetchPage(fn, LIVE)("5")).toEqual({ ok: false, status: 410, error });
  });

  it("throws on a 410 with another body, and on any other failure", async () => {
    await expect(changesFetchPage(stub(() => json({ error: "gone" }, 410)).fn, LIVE)("5")).rejects.toThrow();
    await expect(changesFetchPage(stub(() => json({ error: "x" }, 502)).fn, LIVE)("5")).rejects.toThrow();
    await expect(changesFetchPage(stub(() => json({ error: "x" }, 400)).fn, LIVE)(null)).rejects.toThrow();
  });
});

describe("a sign-out while a feed page is being read", () => {
  it("leaves the store empty and throws SignedOutError", async () => {
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((r) => (releaseBody = r));
    let bodyStarted!: () => void;
    const reading = new Promise<void>((r) => (bodyStarted = r));
    const p = page([list("l1", "One")], "1");
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/bff/api/sync/info") return json({ server_id: "s", timezone: "UTC", capabilities: {} });
      // Headers now; pull runs only once res.json() reads (highWaterMark 0),
      // and the body arrives only when the gate opens.
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            bodyStarted();
            await bodyGate;
            controller.enqueue(new TextEncoder().encode(JSON.stringify(p)));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const store = new MirrorStore();
    const session = createSessionClient(fetchFn, { store, locks: null, channel: null });
    const loader = createLoader(createBffFetch(fetchFn, session), store, session);
    const loading = loader.load();
    await reading;
    session.markSignedOut();
    releaseBody();
    await expect(loading).rejects.toBeInstanceOf(SignedOutError);
    expect(store.lists()).toEqual([]);
    expect(store.tasks()).toEqual([]);
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
    const loader = createLoader(fn, store, LIVE);
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
    const loader = createLoader(server().fn, new MirrorStore(), LIVE);
    await loader.load();
    expect(loader.today(new Date("2026-11-27T04:30:00Z"))).toBe("2026-11-26");
  });

  it("falls back to the browser's zone when /sync/info has no timezone, and logs once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fn } = stub((path) =>
      path === "sync/info" ? json({ server_id: "s", capabilities: {} }) : json(page([], "1")),
    );
    const loader = createLoader(fn, new MirrorStore(), LIVE);
    await loader.load();
    await loader.load();
    expect(loader.info()?.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the browser's zone when /sync/info names a zone that doesn't exist", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fn } = stub((path) =>
      path === "sync/info" ? json({ server_id: "s", timezone: "Not/AZone", capabilities: {} }) : json(page([], "1")),
    );
    const loader = createLoader(fn, new MirrorStore(), LIVE);
    await loader.load();
    await loader.load();
    expect(loader.info()?.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(() => loader.today()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("throws when /sync/info fails", async () => {
    const loader = createLoader(stub(() => json({ error: "x" }, 502)).fn, new MirrorStore(), LIVE);
    await expect(loader.load()).rejects.toThrow();
  });

  it("reload() pulls incrementally from the kept cursor", async () => {
    const { fn, paths } = server();
    const store = new MirrorStore();
    const loader = createLoader(fn, store, LIVE);
    await loader.load();
    paths.length = 0;
    await loader.reload();
    expect(paths).toEqual(["sync/changes?scope=active&limit=1000&cursor=2"]);
    expect(store.lists().map((l) => l.id)).toEqual(["l1", "l2", "l3"]);
  });

  it("reload() before a load does nothing", async () => {
    const { fn, paths } = server();
    await createLoader(fn, new MirrorStore(), LIVE).reload();
    expect(paths).toEqual([]);
  });

  it("concurrent reloads share one pull", async () => {
    const { fn, paths } = server();
    const loader = createLoader(fn, new MirrorStore(), LIVE);
    await loader.load();
    paths.length = 0;
    await Promise.all([loader.reload(), loader.reload()]);
    expect(paths).toHaveLength(1);
  });
});

describe("pullAfter", () => {
  // A feed whose incremental pages wait until released, so a pull can be held in flight.
  function gatedServer() {
    const gates: (() => void)[] = [];
    let n = 0;
    const paths: string[] = [];
    const fn: BffFetch = async (path) => {
      paths.push(path);
      if (path === "sync/info") return json({ server_id: "s", timezone: "UTC", capabilities: {} });
      const cursor = new URLSearchParams(path.split("?")[1]).get("cursor");
      if (cursor === null) return json(page([], "0"));
      await new Promise<void>((r) => gates.push(r));
      n += 1;
      return json(page([list(`l${n}`, "Example")], String(n)));
    };
    return { fn, paths, gates };
  }
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it("waits for a pull already in flight, then runs a fresh one", async () => {
    const { fn, paths, gates } = gatedServer();
    const loader = createLoader(fn, new MirrorStore(), LIVE);
    await loader.load();
    paths.length = 0;
    const early = loader.reload();
    await tick();
    let done = false;
    const after = loader.pullAfter().then(() => (done = true));
    await tick();
    expect(paths).toHaveLength(1);
    gates.shift()!();
    await early;
    await tick();
    // The in-flight pull may have started before the server applied the
    // edit, so pullAfter doesn't count it: a second pull starts.
    expect(done).toBe(false);
    expect(paths).toEqual(["sync/changes?scope=active&limit=1000&cursor=0", "sync/changes?scope=active&limit=1000&cursor=1"]);
    gates.shift()!();
    await after;
  });

  it("runs a fresh pull at once when none is in flight, and still pulls after a failed one", async () => {
    let fail = true;
    const paths: string[] = [];
    const fn: BffFetch = async (path) => {
      paths.push(path);
      if (path === "sync/info") return json({ server_id: "s", timezone: "UTC", capabilities: {} });
      if (path.includes("cursor=") && fail) {
        fail = false;
        return json({ error: "x" }, 502);
      }
      return json(page([], "1"));
    };
    const loader = createLoader(fn, new MirrorStore(), LIVE);
    await loader.load();
    paths.length = 0;
    const failing = loader.reload();
    const after = loader.pullAfter();
    await expect(failing).rejects.toThrow();
    await after;
    expect(paths).toHaveLength(2);
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
