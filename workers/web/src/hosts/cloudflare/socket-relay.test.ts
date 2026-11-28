import { describe, expect, it } from "vitest";
import { type RelaySocket, relay, type SocketRuntime } from "./socket-relay.ts";

const SERVER = "https://server.example.com";
const PATH = "/api/v1/sync/socket" as const;

type Listener = (e: unknown) => void;

/** A Workers WebSocket end as the relay uses it, recording what it is asked to do. */
class FakeSocket implements RelaySocket {
  accepted = false;
  sent: unknown[] = [];
  closes: { code: number; reason: string }[] = [];
  /** Everything in call order, so a test can see a send come before a close. */
  log: string[] = [];
  #listeners = new Map<string, Listener[]>();

  accept() {
    this.accepted = true;
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
    this.log.push(`send ${typeof data === "string" ? data : "binary"}`);
  }
  close(code: number, reason: string) {
    this.closes.push({ code, reason });
    this.log.push(`close ${code}`);
  }
  // `never` accepts every overload's listener; dispatch hands it whatever event the test builds.
  addEventListener(type: string, fn: (e: never) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn as Listener]);
  }
  dispatch(type: string, e: unknown) {
    for (const fn of this.#listeners.get(type) ?? []) fn(e);
  }
}

/** The runtime's timers on a virtual clock: advance() fires what falls due. */
function fakeClock(start = 1_800_000_000_000) {
  let now = start;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    schedule(fn: () => void, ms: number) {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    live: () => timers.filter((x) => x.live).map((x) => x.at - now),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        due.live = false;
        due.fn();
      }
      now = end;
    },
  };
}

function setup(answer: (req: Request) => Promise<unknown>) {
  const client = new FakeSocket();
  const browser = new FakeSocket();
  const requests: Request[] = [];
  const upgradedWith: unknown[] = [];
  const order: string[] = [];
  const clock = fakeClock();
  const runtime: SocketRuntime = {
    pair: () => {
      order.push("pair");
      return [client, browser];
    },
    upgraded: (c) => {
      upgradedWith.push(c);
      return new Response("upgraded");
    },
    schedule: clock.schedule,
    now: clock.now,
  };
  const upstream = async (req: Request) => {
    order.push("upstream");
    requests.push(req);
    return (await answer(req)) as Response;
  };
  return { client, browser, requests, upgradedWith, runtime, upstream, clock, order };
}

function openHeaders() {
  return new Headers({ authorization: "Bearer access-1", upgrade: "websocket" });
}

/** Far enough ahead that no test reaches it unless it means to. */
const FAR = 1_800_000_000_000 + 24 * 3600_000;

/** A relay with a live upstream socket. */
async function connected(closeAt = FAR) {
  const up = new FakeSocket();
  const s = setup(async () => ({ status: 101, webSocket: up }));
  const res = await relay({ path: PATH, headers: openHeaders(), closeAt }, s.upstream, SERVER, s.runtime);
  return { ...s, up, res };
}

describe("relay", () => {
  it("connects upstream with exactly the authorized headers and answers with the client end", async () => {
    const { requests, upgradedWith, client, browser, up, res } = await connected();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${SERVER}${PATH}`);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].redirect).toBe("manual");
    expect([...requests[0].headers]).toEqual([
      ["authorization", "Bearer access-1"],
      ["upgrade", "websocket"],
    ]);
    expect(upgradedWith).toEqual([client]);
    expect(await res.text()).toBe("upgraded");
    expect(browser.accepted).toBe(true);
    expect(up.accepted).toBe(true);
    expect(client.accepted).toBe(false);
  });

  it("forwards server messages to the browser unchanged, text and binary", async () => {
    const { browser, up } = await connected();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    up.dispatch("message", { data: '{"type":"hello","cursor":"k1.1"}' });
    up.dispatch("message", { data: "pong" });
    up.dispatch("message", { data: bytes });
    expect(browser.sent).toEqual(['{"type":"hello","cursor":"k1.1"}', "pong", bytes]);
    expect(browser.sent[2]).toBe(bytes);
    expect(browser.closes).toEqual([]);
  });

  it("forwards a browser ping to the server", async () => {
    const { browser, up } = await connected();
    browser.dispatch("message", { data: "ping" });
    expect(up.sent).toEqual(["ping"]);
    expect(up.closes).toEqual([]);
  });

  const notPing: [string, unknown][] = [
    ["other text", "hello"],
    ["ping with a space", "ping "],
    ["ping in capitals", "PING"],
    ["over 64 bytes", "p".repeat(65)],
    ["binary ping", new TextEncoder().encode("ping").buffer],
  ];
  for (const [label, data] of notPing) {
    it(`closes both with 1008 for a browser message that isn't ping: ${label}`, async () => {
      const { browser, up } = await connected();
      browser.dispatch("message", { data });
      expect(up.sent, label).toEqual([]);
      expect(browser.closes.map((c) => c.code), label).toEqual([1008]);
      expect(up.closes.map((c) => c.code), label).toEqual([1008]);
    });
  }

  it("forwards reauth, then closes the browser with 4001 and the server with 1000", async () => {
    const { browser, up } = await connected();
    up.dispatch("message", { data: '{"type":"reauth"}' });
    expect(browser.log).toEqual(['send {"type":"reauth"}', "close 4001"]);
    expect(browser.closes).toEqual([{ code: 4001, reason: "session" }]);
    expect(up.closes.map((c) => c.code)).toEqual([1000]);
    // The server's close that follows changes nothing.
    up.dispatch("close", { code: 1000, reason: "" });
    browser.dispatch("close", { code: 4001, reason: "session" });
    expect(browser.closes).toHaveLength(1);
    expect(up.closes).toHaveLength(1);
  });

  it("does not treat a changed message as reauth", async () => {
    const { browser, up } = await connected();
    up.dispatch("message", { data: '{"type":"changed","cursor":"k1.2"}' });
    expect(browser.closes).toEqual([]);
  });

  it("creates and accepts the browser's end before connecting upstream", async () => {
    const { order } = await connected();
    expect(order).toEqual(["pair", "upstream"]);
  });

  it("never connects upstream when the pair can't be created", async () => {
    const s = setup(async () => ({ status: 101, webSocket: new FakeSocket() }));
    s.runtime.pair = () => {
      throw new Error("no pair");
    };
    await expect(relay({ path: PATH, headers: openHeaders(), closeAt: FAR }, s.upstream, SERVER, s.runtime)).rejects.toThrow();
    expect(s.requests).toHaveLength(0);
  });

  it("closes both with 4001 when the session ends, and not before", async () => {
    const { browser, up, clock } = await connected(1_800_000_000_000 + 5000);
    clock.advance(4999);
    expect(browser.closes).toEqual([]);
    clock.advance(1);
    expect(browser.closes).toEqual([{ code: 4001, reason: "session" }]);
    expect(up.closes).toEqual([{ code: 4001, reason: "session" }]);
  });

  it("cancels the session-end timer when the sockets close first", async () => {
    const { up, clock } = await connected(1_800_000_000_000 + 5000);
    expect(clock.live()).toEqual([5000]);
    up.dispatch("close", { code: 1000, reason: "" });
    expect(clock.live()).toEqual([]);
  });

  it("forwards the server's normal close code and reason to the browser", async () => {
    for (const code of [1000, 1001, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 4000, 4999]) {
      const { browser, up } = await connected();
      up.dispatch("close", { code, reason: "bye" });
      expect(browser.closes, String(code)).toEqual([{ code, reason: "bye" }]);
      expect(up.closes, String(code)).toEqual([{ code, reason: "bye" }]);
    }
  });

  it("maps any other server close code to 1011", async () => {
    for (const code of [999, 1004, 1005, 1006, 1015, 1016, 2999, 5000]) {
      const s = await connected();
      s.up.dispatch("close", { code, reason: "" });
      expect(s.browser.closes.map((c) => c.code), String(code)).toEqual([1011]);
    }
  });

  it("truncates a close reason to 123 bytes without splitting a character", async () => {
    const { browser, up } = await connected();
    up.dispatch("close", { code: 1000, reason: "é".repeat(100) });
    const reason = browser.closes[0].reason;
    expect(new TextEncoder().encode(reason).length).toBe(122);
    expect(reason).toBe("é".repeat(61));
  });

  it("closes the server when the browser closes", async () => {
    const { browser, up } = await connected();
    browser.dispatch("close", { code: 1001, reason: "going away" });
    expect(up.closes).toEqual([{ code: 1001, reason: "going away" }]);
    expect(browser.closes).toEqual([{ code: 1001, reason: "going away" }]);
    up.dispatch("close", { code: 1001, reason: "" });
    expect(up.closes).toHaveLength(1);
    expect(browser.closes).toHaveLength(1);
  });

  it("closes both with 1011 on an error from either side", async () => {
    for (const side of ["up", "browser"] as const) {
      const s = await connected();
      s[side].dispatch("error", new Error("boom"));
      expect(s.browser.closes.map((c) => c.code), side).toEqual([1011]);
      expect(s.up.closes.map((c) => c.code), side).toEqual([1011]);
    }
  });

  it("drops messages after a close", async () => {
    const { browser, up } = await connected();
    browser.dispatch("message", { data: "nope" });
    up.dispatch("message", { data: "late" });
    browser.dispatch("message", { data: "ping" });
    expect(browser.sent).toEqual([]);
    expect(up.sent).toEqual([]);
  });

  it("survives a send or close that throws", async () => {
    const { browser, up } = await connected();
    browser.send = () => {
      throw new Error("closed");
    };
    up.close = () => {
      throw new Error("closed");
    };
    expect(() => up.dispatch("message", { data: "x" })).not.toThrow();
    expect(browser.closes.map((c) => c.code)).toEqual([1011]);
  });
});

describe("relay when the upstream refuses", () => {
  const cases: [string, () => Promise<unknown>, number, string][] = [
    ["401", async () => new Response("{}", { status: 401 }), 4001, "session"],
    ["403", async () => new Response("{}", { status: 403 }), 4001, "session"],
    ["500", async () => new Response("{}", { status: 500 }), 1011, "upstream"],
    ["302", async () => new Response(null, { status: 302, headers: { location: "https://other.example.com/" } }), 1011, "upstream"],
    ["200 without a socket", async () => new Response("{}", { status: 200 }), 1011, "upstream"],
    ["101 without a socket", async () => ({ status: 101, webSocket: null }), 1011, "upstream"],
    [
      "a network failure",
      async () => {
        throw new TypeError("fetch failed");
      },
      1011,
      "upstream",
    ],
  ];
  for (const [label, answer, code, reason] of cases) {
    it(`answers with the client end, then closes it at once with ${code}: ${label}`, async () => {
      const s = setup(answer);
      await relay({ path: PATH, headers: openHeaders(), closeAt: FAR }, s.upstream, SERVER, s.runtime);
      expect(s.upgradedWith, label).toEqual([s.client]);
      expect(s.browser.accepted, label).toBe(true);
      expect(s.browser.closes, label).toEqual([{ code, reason }]);
      s.browser.dispatch("close", { code, reason });
      expect(s.browser.closes, label).toHaveLength(1);
    });
  }
});

describe("relay when the upstream doesn't answer", () => {
  function hanging() {
    let answer!: (v: unknown) => void;
    const s = setup(() => new Promise((r) => (answer = r)));
    const pending = relay({ path: PATH, headers: openHeaders(), closeAt: FAR }, s.upstream, SERVER, s.runtime);
    return { ...s, pending, answer: (v: unknown) => answer(v) };
  }

  it("gives up after 10 s and closes the page's end with 1011", async () => {
    const s = hanging();
    await Promise.resolve();
    s.clock.advance(9_999);
    let done = false;
    void s.pending.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false);
    s.clock.advance(1);
    expect(await (await s.pending).text()).toBe("upgraded");
    expect(s.upgradedWith).toEqual([s.client]);
    expect(s.browser.closes).toEqual([{ code: 1011, reason: "upstream" }]);
  });

  it("accepts and closes with 1000 an upstream socket that arrives after the timeout", async () => {
    const s = hanging();
    await Promise.resolve();
    s.clock.advance(10_000);
    await s.pending;
    const late = new FakeSocket();
    s.answer({ status: 101, webSocket: late });
    await new Promise((r) => setTimeout(r, 0));
    expect(late.accepted).toBe(true);
    expect(late.closes).toEqual([{ code: 1000, reason: "timeout" }]);
    expect(s.browser.closes).toHaveLength(1);
  });

  it("cancels the timeout when the upstream answers in time", async () => {
    const { clock } = await connected();
    expect(clock.live()).toEqual([FAR - 1_800_000_000_000]); // only the session-end timer
  });
});
