import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MirrorStore } from "../sync/store.ts";
import { type LockRequester, type SessionClient, createSessionClient, watchSession } from "./session.ts";

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

const LOCAL_START = Date.parse("2026-11-27T12:00:00Z");

/** A signed-in /bff/session answer; times in epoch seconds. */
function signedInInfo(over: Record<string, number> = {}) {
  const now = over.now ?? LOCAL_START / 1000;
  return { signed_in: true, expires_at: now + 12 * 3600, idle_minutes: 60, refresh_at: now + 3540, now, data_key: "k", ...over };
}

describe("createSessionClient", () => {
  let store: MirrorStore;
  beforeEach(() => {
    store = filledStore();
  });

  it("current() reads GET /bff/session", async () => {
    const info = signedInInfo();
    const { fn, calls } = stubFetch(() => json(info));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    expect(await client.current()).toEqual(info);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /bff/session"]);
    expect(store.lists()).toHaveLength(1);
  });

  it("current({ activity: true }) sends X-Potem-Activity: 1; current() and ensureFresh() don't", async () => {
    const { fn, calls } = stubFetch(() => json(signedInInfo()));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    await client.current();
    await client.ensureFresh();
    await client.current({ activity: true });
    expect(calls.map((c) => c.headers.get("x-potem-activity"))).toEqual([null, null, "1"]);
  });

  it("current() runs under the potem-refresh lock, so it never crosses a refresh in another tab", async () => {
    const { fn } = stubFetch(() => json(signedInInfo()));
    const locks = fakeLocks();
    const client = createSessionClient(fn, { store, locks, channel: null });
    await client.current();
    expect(locks.names).toEqual(["potem-refresh"]);
  });

  it("limits() gives the session's deadlines in this device's time, corrected by the BFF's clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(LOCAL_START);
    // The BFF's clock is 5 minutes ahead of this device's.
    const serverNow = LOCAL_START / 1000 + 300;
    const { fn } = stubFetch(() => json(signedInInfo({ now: serverNow, expires_at: serverNow + 3600, refresh_at: serverNow + 600, idle_minutes: 30 })));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    expect(client.limits()).toBeNull();
    await client.current();
    expect(client.limits()).toEqual({ endsAt: LOCAL_START + 3600_000, refreshAt: LOCAL_START + 600_000, idleMs: 30 * 60_000 });
  });

  it("ensureFresh() checks the session and refreshes when the access token is due", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(LOCAL_START);
    const now = LOCAL_START / 1000;
    let due = true;
    const { fn, calls } = stubFetch((c) =>
      c.url === "/bff/session" ? json(signedInInfo({ now, refresh_at: due ? now - 1 : now + 600 })) : new Response(null, { status: 204 }),
    );
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    expect(await client.ensureFresh()).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /bff/session", "POST /bff/session/refresh"]);
    due = false;
    expect(await client.ensureFresh()).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("ensureFresh() answers false, without a refresh, when the session is over", async () => {
    const { fn, calls } = stubFetch(() => json({ signed_in: false }));
    const client = createSessionClient(fn, { store, locks: null, channel: null });
    expect(await client.ensureFresh()).toBe(false);
    expect(calls).toHaveLength(1);
    expect(client.signedOut).toBe(true);
  });

  it("touch() records activity and tells the other tabs, which record it too", async () => {
    const { fn } = stubFetch(() => json({}));
    const other = createSessionClient(fn, { store: filledStore(), locks: null, channel: channel() });
    const client = createSessionClient(fn, { store, locks: null, channel: channel() });
    const before = other.lastActivity;
    await new Promise((r) => setTimeout(r, 5));
    client.touch();
    expect(client.lastActivity).toBeGreaterThan(before);
    await vi.waitFor(() => expect(other.lastActivity).toBeGreaterThan(before));
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

describe("watchSession", () => {
  type Answer = Record<string, unknown>;
  /** A real session client over a stub BFF whose answers the test sets. */
  async function setup(first: Answer = signedInInfo(), ch: BroadcastChannel | null = null) {
    vi.useFakeTimers();
    vi.setSystemTime(LOCAL_START);
    let session: Answer = first;
    let refreshes = 0;
    const { fn, calls } = stubFetch((c) => {
      // The BFF's clock follows this device's, as the times in `session` don't.
      if (c.url === "/bff/session") return json(session.signed_in ? { ...session, now: Date.now() / 1000 } : session);
      refreshes++;
      return new Response(null, { status: 204 });
    });
    const client = createSessionClient(fn, { store: filledStore(), locks: null, channel: ch });
    await client.current(); // the page's check on load
    const target = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const win = new EventTarget();
    const stop = watchSession(client, { target, doc, win });
    const sessionChecks = () => calls.filter((c) => c.url === "/bff/session").length - 1;
    return {
      client,
      target,
      doc,
      win,
      stop,
      calls,
      sessionChecks,
      refreshes: () => refreshes,
      answer: (a: Answer) => (session = a),
    };
  }
  const seconds = (s: number) => s * 1000;
  const pageshow = (persisted: boolean) => Object.assign(new Event("pageshow"), { persisted });

  it("reports activity to the BFF at once, then at most once a minute, the last activity at the window's end", async () => {
    const { target, calls } = await setup();
    const reports = () => calls.filter((c) => c.headers.get("x-potem-activity") === "1").length;
    expect(reports()).toBe(0); // the check on load is not activity
    target.dispatchEvent(new Event("pointerdown"));
    expect(reports()).toBe(1);
    vi.advanceTimersByTime(30_000);
    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("keydown"));
    expect(reports()).toBe(1);
    vi.advanceTimersByTime(29_999);
    expect(reports()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(reports()).toBe(2); // the activity at 30 s reaches the BFF at 60 s
    vi.advanceTimersByTime(10 * 60_000);
    expect(reports()).toBe(2); // nothing more without activity
    target.dispatchEvent(new Event("keydown"));
    expect(reports()).toBe(3);
    // Every session read the page sends is a report or one of its own checks.
    expect(calls.filter((c) => c.url === "/bff/session").length).toBe(4);
  });

  it("counts the page becoming visible, not hidden, 250 ms after it does", async () => {
    const { doc, sessionChecks } = await setup();
    vi.advanceTimersByTime(60_000);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(250);
    expect(sessionChecks()).toBe(0);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(249);
    expect(sessionChecks()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(sessionChecks()).toBe(1);
  });

  it("on becoming visible, waits 250 ms so another tab's queued activity counts first", async () => {
    // A frozen tab hears the other tabs' activity only after it wakes; the
    // messages arrive just after visibilitychange.
    const ch = Object.assign(new EventTarget(), { postMessage: () => {} }) as unknown as BroadcastChannel;
    const { client, doc } = await setup(signedInInfo({ idle_minutes: 10 }), ch);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(LOCAL_START + seconds(11 * 60));
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    ch.dispatchEvent(new MessageEvent("message", { data: { type: "activity" } }));
    vi.advanceTimersByTime(250);
    expect(client.signedOut).toBe(false);
  });

  it("a page hidden again within the 250 ms doesn't count as visible", async () => {
    const { doc, sessionChecks } = await setup();
    vi.advanceTimersByTime(60_000);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    doc.visibilityState = "hidden";
    vi.advanceTimersByTime(250);
    expect(sessionChecks()).toBe(0);
  });

  it("signs out at expires_at without asking the BFF, however active the page is", async () => {
    const now = LOCAL_START / 1000;
    const { client, target, calls } = await setup(signedInInfo({ expires_at: now + 600, refresh_at: now + 3540 }));
    const before = calls.length;
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(seconds(60));
      target.dispatchEvent(new Event("pointerdown"));
    }
    // The throttled checks still ran; nothing else did.
    calls.splice(before).forEach((c) => expect(c.url).toBe("/bff/session"));
    expect(client.signedOut).toBe(false);
    await vi.advanceTimersByTimeAsync(seconds(60));
    expect(client.signedOut).toBe(true);
  });

  it("signs out after idle_minutes without activity, and activity moves the deadline", async () => {
    const { client, target } = await setup(signedInInfo({ idle_minutes: 10 }));
    await vi.advanceTimersByTimeAsync(seconds(9 * 60));
    target.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(seconds(9 * 60));
    expect(client.signedOut).toBe(false);
    await vi.advanceTimersByTimeAsync(seconds(60));
    expect(client.signedOut).toBe(true);
  });

  it("counts another tab's activity, heard on potem-session", async () => {
    // A synchronous stand-in for the channel; fake timers don't drive a real one.
    const ch = Object.assign(new EventTarget(), { postMessage: () => {} }) as unknown as BroadcastChannel;
    const { client } = await setup(signedInInfo({ idle_minutes: 10 }), ch);
    await vi.advanceTimersByTimeAsync(seconds(9 * 60));
    ch.dispatchEvent(new MessageEvent("message", { data: { type: "activity" } }));
    await vi.advanceTimersByTimeAsync(seconds(9 * 60));
    expect(client.signedOut).toBe(false);
    await vi.advanceTimersByTimeAsync(seconds(60));
    expect(client.signedOut).toBe(true);
  });

  it("re-checks when the page becomes visible: a tab hidden past the idle limit signs out instead of counting as activity", async () => {
    const { client, doc, sessionChecks } = await setup(signedInInfo({ idle_minutes: 10 }));
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    // The device slept: the clock moved, no timer ran.
    vi.setSystemTime(LOCAL_START + seconds(11 * 60));
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(250);
    expect(client.signedOut).toBe(true);
    expect(sessionChecks()).toBe(0);
  });

  it("re-checks on a back-forward cache restore, not on an ordinary pageshow", async () => {
    const { client, win } = await setup(signedInInfo({ idle_minutes: 10 }));
    vi.setSystemTime(LOCAL_START + seconds(11 * 60));
    win.dispatchEvent(pageshow(false));
    expect(client.signedOut).toBe(false);
    win.dispatchEvent(pageshow(true));
    expect(client.signedOut).toBe(true);
  });

  it("refreshes at refresh_at after activity, then reads the session again and re-arms at the new time", async () => {
    const now = LOCAL_START / 1000;
    const s = await setup(signedInInfo({ refresh_at: now + 600, idle_minutes: 120 }));
    await vi.advanceTimersByTimeAsync(seconds(550));
    s.target.dispatchEvent(new Event("keydown")); // reported at once: the BFF has it
    await vi.advanceTimersByTimeAsync(seconds(40));
    s.target.dispatchEvent(new Event("keydown")); // not reported yet (the minute isn't over)
    await vi.advanceTimersByTimeAsync(seconds(9));
    expect(s.refreshes()).toBe(0);
    s.answer(signedInInfo({ now: now + 600, refresh_at: now + 1200, idle_minutes: 120 }));
    await vi.advanceTimersByTimeAsync(seconds(1));
    expect(s.refreshes()).toBe(1);
    // The same pattern before the new refresh_at refreshes again.
    await vi.advanceTimersByTimeAsync(seconds(550));
    s.target.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(seconds(40));
    s.target.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(seconds(9));
    expect(s.refreshes()).toBe(1);
    await vi.advanceTimersByTimeAsync(seconds(1));
    expect(s.refreshes()).toBe(2);
  });

  it("retries a refresh that didn't move refresh_at after 30 s, not in a loop", async () => {
    const now = LOCAL_START / 1000;
    const s = await setup(signedInInfo({ refresh_at: now + 60, idle_minutes: 120 }));
    await vi.advanceTimersByTimeAsync(seconds(1));
    s.target.dispatchEvent(new Event("keydown")); // reported at once
    await vi.advanceTimersByTimeAsync(seconds(29));
    s.target.dispatchEvent(new Event("keydown")); // reported at 61 s
    await vi.advanceTimersByTimeAsync(seconds(30));
    expect(s.refreshes()).toBe(1);
    await vi.advanceTimersByTimeAsync(seconds(2));
    s.target.dispatchEvent(new Event("keydown")); // after the 61 s report
    await vi.advanceTimersByTimeAsync(seconds(27));
    expect(s.refreshes()).toBe(1);
    await vi.advanceTimersByTimeAsync(seconds(1));
    expect(s.refreshes()).toBe(2);
  });

  it("doesn't count activity the minute's session check already carried to the BFF", async () => {
    const now = LOCAL_START / 1000;
    const s = await setup(signedInInfo({ refresh_at: now + 120, idle_minutes: 60 }));
    await vi.advanceTimersByTimeAsync(seconds(60));
    s.target.dispatchEvent(new Event("keydown")); // reported at once; the report moves last_seen at the BFF
    await vi.advanceTimersByTimeAsync(seconds(600));
    expect(s.sessionChecks()).toBe(1);
    expect(s.refreshes()).toBe(0);
  });

  it("an unattended page doesn't refresh or touch the session: it signs out at the idle limit", async () => {
    const now = LOCAL_START / 1000;
    const s = await setup(signedInInfo({ refresh_at: now + 59 * 60, idle_minutes: 60 }));
    const before = s.calls.length;
    await vi.advanceTimersByTimeAsync(seconds(60 * 60));
    expect(s.calls.slice(before)).toEqual([]);
    expect(s.client.signedOut).toBe(true);
  });

  it("refreshes a due session as soon as activity comes back", async () => {
    const now = LOCAL_START / 1000;
    const s = await setup(signedInInfo({ refresh_at: now + 300, idle_minutes: 60 }));
    await vi.advanceTimersByTimeAsync(seconds(600));
    expect(s.refreshes()).toBe(0);
    s.target.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.refreshes()).toBe(1);
  });

  for (const type of ["wheel", "touchstart"]) {
    it(`counts ${type} as activity`, async () => {
      const { client, target } = await setup(signedInInfo({ idle_minutes: 10 }));
      await vi.advanceTimersByTimeAsync(seconds(9 * 60));
      target.dispatchEvent(new Event(type));
      await vi.advanceTimersByTimeAsync(seconds(9 * 60));
      expect(client.signedOut).toBe(false);
    });
  }

  it("doesn't refresh a session that went idle first", async () => {
    const now = LOCAL_START / 1000;
    const s = await setup(signedInInfo({ refresh_at: now + 900, idle_minutes: 10 }));
    await vi.advanceTimersByTimeAsync(seconds(1000));
    expect(s.client.signedOut).toBe(true);
    expect(s.refreshes()).toBe(0);
  });

  it("stops listening and timing when stopped", async () => {
    const { client, target, stop, sessionChecks } = await setup(signedInInfo({ idle_minutes: 10 }));
    stop();
    vi.advanceTimersByTime(60_000);
    target.dispatchEvent(new Event("pointerdown"));
    expect(sessionChecks()).toBe(0);
    await vi.advanceTimersByTimeAsync(seconds(20 * 60));
    expect(client.signedOut).toBe(false);
  });
});
