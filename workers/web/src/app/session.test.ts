import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MirrorStore } from "../sync/store.ts";
import { type LockRequester, type SessionClient, createSessionClient, watchActivity } from "./session.ts";

type Call = { url: string; method: string; headers: Headers };

/** A fetch stub that records calls and answers from a handler. */
function stubFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const c = { url: String(input), method: init.method ?? "GET", headers: new Headers(init.headers) };
    calls.push(c);
    return handler(c);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A store holding one task, so a clear is visible. */
function filledStore(): MirrorStore {
  const store = new MirrorStore();
  store.applyPage([
    { kind: "list", id: "l1", seq: 1, deleted: false, data: { name: "Example" } as never },
  ]);
  return store;
}

/** A navigator.locks stand-in that runs one holder at a time and records each request. */
function fakeLocks(): LockRequester & { names: string[] } {
  let tail: Promise<unknown> = Promise.resolve();
  const names: string[] = [];
  return {
    names,
    request<T>(name: string, cb: () => Promise<T>): Promise<T> {
      names.push(name);
      const run = tail.then(cb);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

const channels: BroadcastChannel[] = [];
function channel(): BroadcastChannel {
  const ch = new BroadcastChannel("potem-session");
  channels.push(ch);
  return ch;
}
afterEach(() => {
  for (const ch of channels.splice(0)) ch.close();
  vi.useRealTimers();
});

describe("createSessionClient", () => {
  let store: MirrorStore;
  beforeEach(() => {
    store = filledStore();
  });

  it("current() reads GET /bff/session", async () => {
    const { fn, calls } = stubFetch(() => json({ signed_in: true, expires_at: 1_800_000_000, data_key: "k" }));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    expect(await client.current()).toEqual({ signed_in: true, expires_at: 1_800_000_000, data_key: "k" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /bff/session"]);
    expect(store.lists()).toHaveLength(1);
  });

  it("current() saying signed out runs the signed-out flow", async () => {
    const { fn } = stubFetch(() => json({ signed_in: false }));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    const seen = vi.fn();
    client.onSignedOut(seen);
    expect(await client.current()).toEqual({ signed_in: false });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.lists()).toHaveLength(0);
  });

  it("current() throws on a server error without signing out", async () => {
    const { fn } = stubFetch(() => json({ error: "boom" }, 500));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    const seen = vi.fn();
    client.onSignedOut(seen);
    await expect(client.current()).rejects.toThrow();
    expect(seen).not.toHaveBeenCalled();
    expect(client.signedOut).toBe(false);
  });

  it("ten concurrent refreshOnce calls send one POST with X-Potem, under the potem-refresh lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fn, calls } = stubFetch(async () => {
      await gate;
      return new Response(null, { status: 204 });
    });
    const locks = fakeLocks();
    const client = createSessionClient(fn, { store, locks, channel: null });
    const all = Promise.all(Array.from({ length: 10 }, () => client.refreshOnce()));
    release();
    expect(await all).toEqual(Array(10).fill(true));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/bff/session/refresh");
    expect(calls[0].headers.get("x-potem")).toBe("1");
    expect(calls[0].headers.has("x-potem-force")).toBe(false);
    expect(locks.names).toEqual(["potem-refresh"]);
  });

  it("shares the in-flight refresh without navigator.locks too", async () => {
    const { fn, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    await Promise.all(Array.from({ length: 10 }, () => client.refreshOnce()));
    expect(calls).toHaveLength(1);
  });

  it("a refresh after the previous one settled sends a new POST", async () => {
    const { fn, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    await client.refreshOnce();
    await client.refreshOnce();
    expect(calls).toHaveLength(2);
  });

  it("refreshOnce({ force: true }) sends X-Potem-Force: 1 under the lock", async () => {
    const { fn, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const locks = fakeLocks();
    const client = createSessionClient(fn, { store, locks, channel: null });
    expect(await client.refreshOnce({ force: true })).toBe(true);
    expect(calls[0].headers.get("x-potem")).toBe("1");
    expect(calls[0].headers.get("x-potem-force")).toBe("1");
    expect(locks.names).toEqual(["potem-refresh"]);
  });

  it("a refresh answered signed_out returns false, fires onSignedOut once and clears the store", async () => {
    const { fn } = stubFetch(() => json({ error: "signed_out" }, 401));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    const seen = vi.fn();
    client.onSignedOut(seen);
    expect(await client.refreshOnce()).toBe(false);
    expect(await client.refreshOnce()).toBe(false);
    client.markSignedOut();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.lists()).toHaveLength(0);
    expect(client.signedOut).toBe(true);
  });

  it("the signed-out flow seals the store: a page applied afterwards is ignored", async () => {
    const { fn } = stubFetch(() => json({ signed_in: false }));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    await client.current();
    expect(store.applyPage([{ kind: "list", id: "l2", seq: 2, deleted: false, data: { name: "Late" } as never }])).toBe(false);
    expect(store.lists()).toHaveLength(0);
  });

  it("a refresh waiting on another tab's lock sends nothing once the page has signed out", async () => {
    const { fn, calls } = stubFetch(() => new Response(null, { status: 204 }));
    let releaseLock!: () => void;
    const held = new Promise<void>((r) => (releaseLock = r));
    const locks: LockRequester = {
      request: async <T,>(_name: string, cb: () => Promise<T>) => {
        await held; // another tab holds potem-refresh
        return cb();
      },
    };
    const client = createSessionClient(fn, { store, locks, channel: null });
    const pending = client.refreshOnce();
    client.markSignedOut();
    releaseLock();
    expect(await pending).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a refresh answered 502 throws and keeps the session", async () => {
    const { fn } = stubFetch(() => json({ error: "upstream_unavailable" }, 502));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    await expect(client.refreshOnce()).rejects.toThrow();
    expect(client.signedOut).toBe(false);
    expect(store.lists()).toHaveLength(1);
  });

  it("onSignedOut returns an unsubscribe", async () => {
    const { fn } = stubFetch(() => json({ signed_in: false }));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    const seen = vi.fn();
    client.onSignedOut(seen)();
    await client.current();
    expect(seen).not.toHaveBeenCalled();
  });

  it("logout() POSTs /auth/logout with X-Potem, then runs the signed-out flow", async () => {
    const { fn, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    const seen = vi.fn();
    client.onSignedOut(seen);
    await client.logout();
    expect(calls.map((c) => `${c.method} ${c.url} ${c.headers.get("x-potem")}`)).toEqual(["POST /auth/logout 1"]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.lists()).toHaveLength(0);
  });

  it("logout() that the server refuses throws and leaves the page signed in", async () => {
    const { fn } = stubFetch(() => new Response(null, { status: 403 }));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    await expect(client.logout()).rejects.toThrow();
    expect(client.signedOut).toBe(false);
    expect(store.lists()).toHaveLength(1);
  });

  it("posts signed_out on potem-session, and another tab receiving it clears its store", async () => {
    const { fn } = stubFetch(() => json({ error: "signed_out" }, 401));
    const otherStore = filledStore();
    const other = createSessionClient(fn, { store: otherStore, locks: null, channel: channel() });
    const otherSeen = vi.fn();
    other.onSignedOut(otherSeen);
    const arrived = new Promise<void>((resolve) => other.onSignedOut(() => resolve()));

    const listener = channel();
    const messages: unknown[] = [];
    listener.onmessage = (e) => messages.push(e.data);

    const client = createSessionClient(fn, { store, locks: null, channel: channel() });
    expect(await client.refreshOnce()).toBe(false);
    await arrived;
    expect(otherSeen).toHaveBeenCalledTimes(1);
    expect(otherStore.lists()).toHaveLength(0);
    expect(other.signedOut).toBe(true);
    await vi.waitFor(() => expect(messages).toEqual([{ type: "signed_out" }]));
  });

  it("ignores other messages on the channel", async () => {
    const { fn } = stubFetch(() => json({}));
    const client = createSessionClient(fn, { store, locks: null, channel: channel() });
    const sender = channel();
    sender.postMessage({ type: "something_else" });
    sender.postMessage("signed_out");
    await new Promise((r) => setTimeout(r, 20));
    expect(client.signedOut).toBe(false);
    expect(store.lists()).toHaveLength(1);
  });
});

describe("watchActivity", () => {
  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
    const target = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const current = vi.fn(async () => ({ signed_in: true as const, expires_at: 0, data_key: "k" }));
    const client = { current } as unknown as SessionClient;
    const stop = watchActivity(client, { target, doc });
    return { target, doc, current, stop };
  }

  it("checks the session on activity at most once a minute, counting the check made on load", async () => {
    const { target, current } = setup();
    target.dispatchEvent(new Event("pointerdown"));
    expect(current).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(60_000);
    target.dispatchEvent(new Event("keydown"));
    expect(current).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("keydown"));
    expect(current).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    target.dispatchEvent(new Event("pointerdown"));
    expect(current).toHaveBeenCalledTimes(2);
  });

  it("counts the page becoming visible, not hidden", () => {
    const { doc, current } = setup();
    vi.advanceTimersByTime(60_000);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(current).toHaveBeenCalledTimes(0);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("stops listening when stopped", () => {
    const { target, current, stop } = setup();
    stop();
    vi.advanceTimersByTime(60_000);
    target.dispatchEvent(new Event("pointerdown"));
    expect(current).not.toHaveBeenCalled();
  });
});
