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

function setup(answer: (req: Request) => Promise<unknown>) {
  const client = new FakeSocket();
  const browser = new FakeSocket();
  const requests: Request[] = [];
  const upgradedWith: unknown[] = [];
  const runtime: SocketRuntime = {
    pair: () => [client, browser],
    upgraded: (c) => {
      upgradedWith.push(c);
      return new Response("upgraded");
    },
  };
  const upstream = async (req: Request) => {
    requests.push(req);
    return (await answer(req)) as Response;
  };
  return { client, browser, requests, upgradedWith, runtime, upstream };
}

function openHeaders() {
  return new Headers({ authorization: "Bearer access-1", upgrade: "websocket" });
}

/** A relay with a live upstream socket. */
async function connected() {
  const up = new FakeSocket();
  const s = setup(async () => ({ status: 101, webSocket: up }));
  const res = await relay({ path: PATH, headers: openHeaders() }, s.upstream, SERVER, s.runtime);
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

  it("forwards the server's normal close code and reason to the browser", async () => {
    for (const code of [1000, 1001, 1003, 3000, 4000, 4999]) {
      const { browser, up } = await connected();
      up.dispatch("close", { code, reason: "bye" });
      expect(browser.closes, String(code)).toEqual([{ code, reason: "bye" }]);
      expect(up.closes, String(code)).toEqual([{ code, reason: "bye" }]);
    }
  });

  it("maps any other server close code to 1011", async () => {
    for (const code of [1004, 1005, 1006, 1011, 1015, 2999, 5000]) {
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
      await relay({ path: PATH, headers: openHeaders() }, s.upstream, SERVER, s.runtime);
      expect(s.upgradedWith, label).toEqual([s.client]);
      expect(s.browser.accepted, label).toBe(true);
      expect(s.browser.closes, label).toEqual([{ code, reason }]);
      s.browser.dispatch("close", { code, reason });
      expect(s.browser.closes, label).toHaveLength(1);
    });
  }
});
