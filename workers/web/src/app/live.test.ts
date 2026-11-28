import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SocketLike } from "../sync/push.ts";
import { MirrorStore } from "../sync/store.ts";
import { watchLive } from "./live.ts";
import { SignedOutError } from "./api.ts";
import { type SessionClient, createSessionClient } from "./session.ts";

/**
 * A socket the test drives: it records listeners and the code it was closed
 * with, and answers each ping with "pong" as the server does, so the push
 * client's liveness check is met while the test isn't looking at it.
 */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closedWith: number | null = null;
  #listeners = new Map<string, ((ev: never) => void)[]>();
  send(s: string) {
    this.sent.push(s);
    if (s === "ping") this.emit("message", { data: "pong" });
  }
  close(code?: number) {
    this.closedWith = code ?? 1005;
  }
  addEventListener(type: string, fn: (ev: never) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }
  emit(type: string, ev: unknown = {}) {
    for (const fn of this.#listeners.get(type) ?? []) fn(ev as never);
  }
  hello(cursor = "1") {
    this.emit("open");
    this.emit("message", { data: JSON.stringify({ type: "hello", cursor }) });
  }
  changed(cursor = "2") {
    this.emit("message", { data: JSON.stringify({ type: "changed", cursor }) });
  }
  serverClose(code: number) {
    this.emit("close", { code });
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeDoc(state: "visible" | "hidden" = "visible") {
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = state;
  const set = (s: "visible" | "hidden") => {
    doc.visibilityState = s;
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  return { doc, set };
}

/** A pull the test settles by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type SessionAnswer = "signed_in" | "due" | "signed_out";

type LiveSession = Pick<SessionClient, "ensureFresh" | "onSignedOut" | "signedOut">;

function setup(opts: { session?: SessionAnswer; stub?: LiveSession; state?: "visible" | "hidden" } = {}) {
  const sockets: FakeSocket[] = [];
  const pulls: ReturnType<typeof deferred>[] = [];
  const loader = {
    reload: vi.fn(async () => {}),
    pullAfter: vi.fn(() => {
      const d = deferred();
      pulls.push(d);
      return d.promise;
    }),
  };
  const calls: string[] = [];
  let activityReports = 0;
  const answer = opts.session ?? "signed_in";
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const c = `${init.method ?? "GET"} ${String(input)}`;
    calls.push(c);
    if (new Headers(init.headers).get("x-potem-activity") === "1") activityReports += 1;
    if (c === "POST /bff/session/refresh") return new Response(null, { status: 204 });
    if (answer === "signed_out") return json({ signed_in: false });
    const now = Math.floor(Date.now() / 1000);
    return json({
      signed_in: true,
      expires_at: now + 3600,
      idle_minutes: 60,
      refresh_at: answer === "due" ? now - 1 : now + 1800,
      now,
      data_key: "x",
    });
  }) as typeof fetch;
  const store = new MirrorStore();
  const session = createSessionClient(fetchFn, { store, locks: null, channel: null });
  const { doc, set } = fakeDoc(opts.state);
  const log = vi.fn();
  const stop = watchLive({
    loader,
    session: opts.stub ?? session,
    doc,
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    random: () => 0,
    log,
  });
  const last = () => sockets[sockets.length - 1]!;
  return {
    sockets,
    last,
    pulls,
    loader,
    session,
    calls,
    get activityReports() {
      return activityReports;
    },
    setVisibility: set,
    stop,
    log,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("watchLive", () => {
  it("opens one socket and pulls on hello and on changed", async () => {
    const t = setup();
    expect(t.sockets).toHaveLength(1);
    t.last().hello();
    expect(t.loader.pullAfter).toHaveBeenCalledTimes(1);
    t.pulls[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    t.last().changed();
    expect(t.loader.pullAfter).toHaveBeenCalledTimes(2);
    t.stop();
  });

  it("collapses notices that arrive during a pull into exactly one more pull", async () => {
    const t = setup();
    t.last().hello();
    t.last().changed("2");
    t.last().changed("3");
    t.last().changed("4");
    expect(t.loader.pullAfter).toHaveBeenCalledTimes(1);
    t.pulls[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.loader.pullAfter).toHaveBeenCalledTimes(2);
    t.pulls[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.loader.pullAfter).toHaveBeenCalledTimes(2);
    t.stop();
  });

  it("runs the extra pull even when the pull in flight fails", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    t.loader.pullAfter.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    t.last().hello();
    t.last().changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.loader.pullAfter).toHaveBeenCalledTimes(2);
    t.stop();
  });

  it("polls while the socket isn't open and pauses the poll while it is", async () => {
    const t = setup();
    // Connecting: the poll runs.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.loader.reload).toHaveBeenCalledTimes(1);
    t.last().hello();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.loader.reload).toHaveBeenCalledTimes(1);
    // The server goes away: the poll resumes while the client reconnects.
    t.last().serverClose(1011);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.loader.reload).toHaveBeenCalledTimes(2);
    expect(t.sockets.length).toBeGreaterThan(1);
    t.last().hello();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.loader.reload).toHaveBeenCalledTimes(2);
    t.stop();
  });

  it("closes the socket after 5 minutes hidden and reconnects, pulling on hello, when visible", async () => {
    const t = setup();
    t.last().hello();
    t.pulls[0]!.resolve();
    t.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(t.last().closedWith).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.last().closedWith).toBe(1000);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.loader.reload).not.toHaveBeenCalled(); // the poll doesn't pull while hidden
    t.setVisibility("visible");
    expect(t.sockets).toHaveLength(2);
    t.last().hello();
    expect(t.loader.pullAfter).toHaveBeenCalledTimes(2);
    t.stop();
  });

  it("keeps the socket when the page is shown again within 5 minutes", async () => {
    const t = setup();
    t.last().hello();
    t.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    t.setVisibility("visible");
    t.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(t.last().closedWith).toBeNull();
    expect(t.sockets).toHaveLength(1);
    t.stop();
  });

  it("closes the socket of a page that loads hidden after 5 minutes", async () => {
    const t = setup({ state: "hidden" });
    expect(t.sockets).toHaveLength(1);
    t.last().hello();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.sockets[0]!.closedWith).toBe(1000);
    t.stop();
  });

  it("stops the socket and the poll on sign-out", async () => {
    const t = setup();
    t.last().hello();
    t.session.markSignedOut();
    expect(t.last().closedWith).toBe(1000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.loader.reload).not.toHaveBeenCalled();
  });

  it("stops when the session check after a 4001 finds the session gone, running the sign-out flow", async () => {
    const t = setup({ session: "signed_out" });
    t.last().hello();
    t.last().serverClose(4001);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual(["GET /bff/session"]);
    expect(t.session.signedOut).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.loader.reload).not.toHaveBeenCalled();
  });

  it("stops, without reconnecting or polling, when the session check answers that the session is over", async () => {
    const stub: LiveSession = {
      ensureFresh: vi.fn(async () => false),
      onSignedOut: () => () => {}, // the stub never runs the sign-out flow
      signedOut: false,
    };
    const t = setup({ stub });
    t.last().hello();
    t.last().serverClose(4001);
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.ensureFresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.loader.reload).not.toHaveBeenCalled();
  });

  it("refreshes and reconnects after a 4001 on an unattended page, without reporting activity", async () => {
    const t = setup({ session: "due" });
    vi.advanceTimersByTime(1);
    await t.session.current(); // the last contact, after the last activity
    t.calls.length = 0;
    t.last().hello();
    t.last().serverClose(4001);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual(["GET /bff/session", "POST /bff/session/refresh"]);
    expect(t.activityReports).toBe(0);
    expect(t.sockets).toHaveLength(2);
    t.stop();
  });

  it("doesn't log a pull that ended because the session ended", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    t.loader.pullAfter.mockImplementationOnce(() => Promise.reject(new SignedOutError()));
    t.last().hello();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.loader.pullAfter).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    t.stop();
  });

  it("refreshes a session that is due after a 4001, then reconnects", async () => {
    const t = setup({ session: "due" });
    t.last().hello();
    t.last().serverClose(4001);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual(["GET /bff/session", "POST /bff/session/refresh"]);
    expect(t.sockets).toHaveLength(2);
    t.stop();
  });

  it("reconnects at once without a refresh when the session isn't due", async () => {
    const t = setup();
    t.last().hello();
    t.last().serverClose(4001);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual(["GET /bff/session"]);
    expect(t.sockets).toHaveLength(2);
    t.stop();
  });

  it("stop() closes the socket and nothing runs after it", async () => {
    const t = setup();
    t.last().hello();
    t.stop();
    expect(t.last().closedWith).toBe(1000);
    t.setVisibility("hidden");
    t.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.loader.reload).not.toHaveBeenCalled();
  });
});
