import { describe, expect, it } from "vitest";
import { type PushDeps, type PushState, type SocketLike, createPush } from "./push";

// A virtual clock behind the injected schedule: timers fire only when tick()
// passes their due time, so every delay the client asks for is observable.
function fakeClock() {
  let now = 0;
  let timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    schedule(fn: () => void, ms: number) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    // Delays of the timers still waiting, relative to now.
    waiting: () => timers.filter((t) => t.live).map((t) => t.at - now),
    async tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        due.live = false;
        timers = timers.filter((t) => t.live);
        due.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

type Ev = { data: unknown; code: number };
type Listener = (ev: Ev) => void;

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closedWith: (number | undefined)[] = [];
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close(code?: number) {
    this.closedWith.push(code);
  }
  emit(type: string, ev: Partial<Ev> = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: ev.data, code: ev.code ?? 0 });
  }
  // Server side helpers.
  opened() {
    this.emit("open");
  }
  message(data: unknown) {
    this.emit("message", { data });
  }
  hello(cursor = "c.1") {
    this.message(JSON.stringify({ type: "hello", cursor }));
  }
  closed(code: number) {
    this.emit("close", { code });
  }
}

function harness(over: Partial<PushDeps> = {}) {
  const clock = fakeClock();
  const sockets: FakeSocket[] = [];
  const hellos: string[] = [];
  const changes: string[] = [];
  const states: PushState[] = [];
  const logs: string[] = [];
  let checks = 0;
  let checkAnswer: () => Promise<"ok" | "signed_out"> = async () => "ok";
  const deps: PushDeps = {
    open() {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    schedule: clock.schedule,
    random: () => 0.5, // jitter factor 1.0: delays come out exact
    onHello: (c) => hellos.push(c),
    onChanged: (c) => changes.push(c),
    onSessionCheck: () => {
      checks += 1;
      return checkAnswer();
    },
    onState: (s) => states.push(s),
    log: (e) => logs.push(e),
    ...over,
  };
  const push = createPush(deps);
  return {
    push,
    clock,
    sockets,
    hellos,
    changes,
    states,
    logs,
    last: () => sockets[sockets.length - 1]!,
    checks: () => checks,
    answerChecks(fn: () => Promise<"ok" | "signed_out">) {
      checkAnswer = fn;
    },
  };
}

// Fails the current socket without a hello (the relay's 101 followed by an
// immediate failure close), then waits for the reconnect it schedules.
async function failAndReconnect(h: ReturnType<typeof harness>, code = 1011): Promise<number> {
  h.last().opened();
  h.last().closed(code);
  await settle(); // the third close without a hello waits for a session check
  const [delay] = h.clock.waiting();
  if (delay === undefined) throw new Error("no reconnect scheduled");
  await h.clock.tick(delay);
  return delay;
}

describe("push client", () => {
  it("opens one socket on start, and reports open only after hello", () => {
    const h = harness();
    h.push.start();
    h.push.start(); // idempotent
    expect(h.sockets).toHaveLength(1);
    expect(h.states).toEqual(["connecting"]);
    h.last().opened();
    expect(h.states).toEqual(["connecting"]);
    h.last().hello("k3v9.18460");
    expect(h.states).toEqual(["connecting", "open"]);
    expect(h.hellos).toEqual(["k3v9.18460"]);
  });

  it("passes changed cursors to onChanged", () => {
    const h = harness();
    h.push.start();
    h.last().opened();
    h.last().hello();
    h.last().message(JSON.stringify({ type: "changed", cursor: "k3v9.18461" }));
    h.last().message(JSON.stringify({ type: "changed", cursor: "k3v9.18462" }));
    expect(h.changes).toEqual(["k3v9.18461", "k3v9.18462"]);
  });

  it("ignores malformed JSON, unknown types, reauth, missing cursors and non-string data", () => {
    const h = harness();
    h.push.start();
    h.last().opened();
    for (const data of [
      "{not json",
      "null",
      "42",
      JSON.stringify({ type: "surprise", cursor: "x" }),
      JSON.stringify({ type: "reauth" }),
      JSON.stringify({ type: "changed" }),
      JSON.stringify({ type: "hello", cursor: 7 }),
      new ArrayBuffer(4),
    ]) {
      h.last().message(data);
    }
    expect(h.hellos).toEqual([]);
    expect(h.changes).toEqual([]);
    expect(h.states).toEqual(["connecting"]);
    expect(h.last().closedWith).toEqual([]);
    expect(h.sockets).toHaveLength(1);
  });

  it("pings every 30 s while open, and stops pinging on close", async () => {
    const h = harness();
    h.push.start();
    const s = h.last();
    await h.clock.tick(9_999);
    expect(s.sent).toEqual([]); // not open yet: nothing to send on
    s.opened();
    s.hello();
    await h.clock.tick(29_999);
    expect(s.sent).toEqual([]);
    await h.clock.tick(1);
    expect(s.sent).toEqual(["ping"]);
    for (let i = 0; i < 2; i++) {
      s.message("pong");
      await h.clock.tick(30_000);
    }
    expect(s.sent).toEqual(["ping", "ping", "ping"]);
    s.closed(1006);
    await h.clock.tick(120_000);
    expect(s.sent).toEqual(["ping", "ping", "ping"]);
  });

  it("backs off 1, 2, 4, 8, 16, 30, 30 s when an open closes at once", async () => {
    const h = harness();
    h.push.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) delays.push(await failAndReconnect(h));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(h.sockets).toHaveLength(8);
    expect(h.checks()).toBe(1); // once, after the third close without a hello
  });

  it("reports closed while waiting to reconnect", async () => {
    const h = harness();
    h.push.start();
    h.last().opened();
    h.last().hello();
    h.last().closed(1006);
    expect(h.states).toEqual(["connecting", "open", "closed"]);
    await h.clock.tick(1000);
    expect(h.states).toEqual(["connecting", "open", "closed", "connecting"]);
  });

  it("applies ±20 % jitter from random()", () => {
    const low = harness({ random: () => 0 });
    low.push.start();
    low.last().closed(1006);
    expect(low.clock.waiting()).toEqual([800]);

    const high = harness({ random: () => 0.999 });
    high.push.start();
    high.last().closed(1006);
    const [d] = high.clock.waiting();
    expect(d).toBeGreaterThan(1195);
    expect(d).toBeLessThan(1200);
  });

  it("keeps backing off when each socket closes soon after its hello", async () => {
    const h = harness();
    h.push.start();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      h.last().opened();
      h.last().hello();
      h.last().closed(1006);
      const [d] = h.clock.waiting();
      delays.push(d!);
      await h.clock.tick(d!);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    expect(h.checks()).toBe(0); // each had a hello
  });

  it("resets the backoff once a socket stays open 30 s past its hello", async () => {
    const h = harness();
    h.push.start();
    await failAndReconnect(h);
    await failAndReconnect(h);
    expect(await failAndReconnect(h)).toBe(4000);
    h.last().opened();
    h.last().hello();
    await h.clock.tick(29_999);
    h.last().closed(1006);
    expect(h.clock.waiting()).toEqual([8000]); // 30 s not reached: no reset
    await h.clock.tick(8000);
    h.last().opened();
    h.last().hello();
    await h.clock.tick(30_000);
    h.last().closed(1006);
    expect(h.clock.waiting()).toEqual([1000]);
  });

  describe("liveness", () => {
    it("closes with 4000 and backs off when the transport doesn't open within 10 s", async () => {
      const h = harness();
      h.push.start();
      const s = h.last();
      await h.clock.tick(9_999);
      expect(s.closedWith).toEqual([]);
      await h.clock.tick(1);
      expect(s.closedWith).toEqual([4000]);
      expect(h.states).toEqual(["connecting", "closed"]);
      expect(h.clock.waiting()).toEqual([1000]);
      s.closed(4000); // the browser's close event after ours changes nothing
      s.opened();
      expect(h.clock.waiting()).toEqual([1000]);
      await h.clock.tick(1000);
      expect(h.sockets).toHaveLength(2);
    });

    it("closes with 4000 when no hello arrives within 10 s of the transport opening", async () => {
      const h = harness();
      h.push.start();
      const s = h.last();
      s.opened();
      await h.clock.tick(5000);
      s.message("pong"); // only a hello satisfies this wait
      await h.clock.tick(4_999);
      expect(s.closedWith).toEqual([]);
      await h.clock.tick(1);
      expect(s.closedWith).toEqual([4000]);
      expect(h.states).toEqual(["connecting", "closed"]);
      expect(h.clock.waiting()).toEqual([1000]);
    });

    it("after a ping, any message within 10 s keeps the socket; none closes it", async () => {
      const h = harness();
      h.push.start();
      const s = h.last();
      s.opened();
      s.hello();
      await h.clock.tick(30_000); // t = 30 s: the first ping
      expect(s.sent).toEqual(["ping"]);
      await h.clock.tick(9_999);
      s.message("pong");
      await h.clock.tick(20_001); // t = 60 s: the second ping
      expect(s.sent).toEqual(["ping", "ping"]);
      await h.clock.tick(9_999);
      s.message(new ArrayBuffer(1)); // binary counts too
      await h.clock.tick(1); // t = 70 s: the second ping's deadline passes
      expect(s.closedWith).toEqual([]);
      await h.clock.tick(20_000); // t = 90 s: the third ping, never answered
      expect(s.sent).toEqual(["ping", "ping", "ping"]);
      await h.clock.tick(9_999);
      expect(s.closedWith).toEqual([]);
      await h.clock.tick(1);
      expect(s.closedWith).toEqual([4000]);
      expect(h.states.at(-1)).toBe("closed");
      expect(h.clock.waiting()).toHaveLength(1); // the reconnect
    });
  });

  describe("closes without a hello", () => {
    it("check the session once after three in a row, wait for it, then back off", async () => {
      const h = harness();
      let answer!: (v: "ok" | "signed_out") => void;
      h.answerChecks(() => new Promise((r) => (answer = r)));
      h.push.start();
      await failAndReconnect(h);
      await h.clock.tick(10_000); // a timeout counts as a close without a hello
      await h.clock.tick(h.clock.waiting()[0]!);
      expect(h.checks()).toBe(0);
      h.last().opened();
      h.last().closed(1006);
      await settle();
      expect(h.checks()).toBe(1);
      expect(h.clock.waiting()).toEqual([]); // nothing reconnects while the check runs
      answer("ok");
      await settle();
      expect(h.clock.waiting()).toEqual([4000]); // ok: the normal backoff, not at once
      await h.clock.tick(4000);
      h.answerChecks(async () => "ok");
      for (let i = 0; i < 4; i++) await failAndReconnect(h);
      expect(h.checks()).toBe(1); // once per run of failures
      // A hello ends the run; three more failures check again.
      h.last().opened();
      h.last().hello();
      h.last().closed(1006);
      await h.clock.tick(h.clock.waiting()[0]!);
      for (let i = 0; i < 3; i++) await failAndReconnect(h);
      expect(h.checks()).toBe(2);
    });

    it("stop on signed_out", async () => {
      const h = harness();
      h.answerChecks(async () => "signed_out");
      h.push.start();
      await failAndReconnect(h);
      await failAndReconnect(h);
      h.last().opened();
      h.last().closed(1006);
      await settle();
      await h.clock.tick(120_000);
      expect(h.checks()).toBe(1);
      expect(h.sockets).toHaveLength(3);
      expect(h.clock.waiting()).toEqual([]);
      expect(h.states.at(-1)).toBe("closed");
    });
  });

  it("logs a 1008 close once and backs off like any other close", async () => {
    const h = harness();
    h.push.start();
    expect(await failAndReconnect(h, 1008)).toBe(1000);
    expect(await failAndReconnect(h, 1008)).toBe(2000);
    expect(h.logs).toEqual(["push_policy_close"]);
  });

  it("backs off when open() throws", async () => {
    let n = 0;
    const h = harness({
      open() {
        n += 1;
        throw new Error("bad url");
      },
    });
    h.push.start();
    expect(n).toBe(1);
    expect(h.states).toEqual(["connecting", "closed"]);
    expect(h.clock.waiting()).toEqual([1000]);
    await h.clock.tick(1000);
    expect(n).toBe(2);
    expect(h.clock.waiting()).toEqual([2000]);
  });

  describe("a 4001 close", () => {
    it("checks the session once, waits for it, then reconnects at once on ok", async () => {
      const h = harness();
      let answer!: (v: "ok" | "signed_out") => void;
      h.answerChecks(() => new Promise((r) => (answer = r)));
      h.push.start();
      h.last().opened();
      h.last().hello();
      h.last().closed(4001);
      expect(h.checks()).toBe(1);
      expect(h.states.at(-1)).toBe("closed");
      await h.clock.tick(120_000); // nothing reconnects while the check is pending
      expect(h.sockets).toHaveLength(1);
      expect(h.checks()).toBe(1);
      answer("ok");
      await settle();
      expect(h.sockets).toHaveLength(2);
      expect(h.states.at(-1)).toBe("connecting");
    });

    it("does not reset the backoff counter on ok", async () => {
      const h = harness();
      h.push.start();
      await failAndReconnect(h);
      await failAndReconnect(h); // two failures: the next backoff is 4 s
      h.last().opened();
      h.last().closed(4001);
      await settle();
      expect(h.sockets).toHaveLength(4); // ok: reconnected at once
      h.last().closed(1006);
      // The waiting timers are this reconnect and the 10 s window after the 4001.
      expect(h.clock.waiting().sort((a, b) => a - b)).toEqual([4000, 10_000]);
    });

    it("backs off before the reconnect when two 4001s come within 10 s", async () => {
      const h = harness();
      h.push.start();
      h.last().opened();
      h.last().closed(4001);
      await settle();
      expect(h.sockets).toHaveLength(2); // the first reconnects at once
      await h.clock.tick(5000);
      h.last().opened();
      h.last().closed(4001);
      await settle();
      expect(h.checks()).toBe(2);
      expect(h.sockets).toHaveLength(2); // the second waits for a backoff
      await h.clock.tick(999);
      expect(h.sockets).toHaveLength(2);
      await h.clock.tick(1);
      expect(h.sockets).toHaveLength(3);
    });

    it("reconnects at once when two 4001s are more than 10 s apart", async () => {
      const h = harness();
      h.push.start();
      h.last().opened();
      h.last().closed(4001);
      await settle();
      h.last().opened();
      h.last().hello();
      await h.clock.tick(10_001);
      h.last().closed(4001);
      await settle();
      expect(h.sockets).toHaveLength(3);
    });

    it("stops on signed_out", async () => {
      const h = harness();
      h.answerChecks(async () => "signed_out");
      h.push.start();
      h.last().opened();
      h.last().hello();
      h.last().closed(4001);
      await settle();
      await h.clock.tick(120_000);
      expect(h.checks()).toBe(1);
      expect(h.sockets).toHaveLength(1);
      expect(h.clock.waiting()).toEqual([]);
      expect(h.states.at(-1)).toBe("closed");
    });

    it("backs off when the check throws", async () => {
      const h = harness();
      h.answerChecks(async () => {
        throw new Error("network");
      });
      h.push.start();
      h.last().opened();
      h.last().closed(4001);
      await settle();
      expect(h.sockets).toHaveLength(1);
      expect(h.clock.waiting()).toContain(1000);
      await h.clock.tick(1000);
      expect(h.sockets).toHaveLength(2);
    });
  });

  describe("stop", () => {
    it("closes the socket with 1000 and cancels every timer", async () => {
      const h = harness();
      h.push.start();
      const s = h.last();
      s.opened();
      s.hello();
      h.push.stop();
      expect(s.closedWith).toEqual([1000]);
      expect(h.clock.waiting()).toEqual([]);
      expect(h.states.at(-1)).toBe("closed");
      s.closed(1000); // the browser's close event after our close
      s.message(JSON.stringify({ type: "changed", cursor: "late" }));
      await h.clock.tick(120_000);
      expect(h.sockets).toHaveLength(1);
      expect(s.sent).toEqual([]);
      expect(h.changes).toEqual([]);
    });

    it("cancels a pending reconnect", async () => {
      const h = harness();
      h.push.start();
      h.last().closed(1006);
      expect(h.clock.waiting()).toEqual([1000]);
      h.push.stop();
      expect(h.clock.waiting()).toEqual([]);
      await h.clock.tick(120_000);
      expect(h.sockets).toHaveLength(1);
    });

    it("ignores a session check that finishes after stop", async () => {
      const h = harness();
      let answer!: (v: "ok" | "signed_out") => void;
      h.answerChecks(() => new Promise((r) => (answer = r)));
      h.push.start();
      h.last().opened();
      h.last().closed(4001);
      h.push.stop();
      answer("ok");
      await settle();
      await h.clock.tick(120_000);
      expect(h.sockets).toHaveLength(1);
    });

    it("start after stop connects again", async () => {
      const h = harness();
      h.push.start();
      h.last().opened();
      h.last().hello("c.1");
      h.push.stop();
      h.push.start();
      expect(h.sockets).toHaveLength(2);
      h.last().opened();
      h.last().hello("c.2");
      expect(h.hellos).toEqual(["c.1", "c.2"]);
      expect(h.states).toEqual(["connecting", "open", "closed", "connecting", "open"]);
    });

    it("a stale session check from before stop cannot drive the new run", async () => {
      const h = harness();
      let answer!: (v: "ok" | "signed_out") => void;
      h.answerChecks(() => new Promise((r) => (answer = r)));
      h.push.start();
      h.last().opened();
      h.last().closed(4001);
      h.push.stop();
      h.push.start();
      expect(h.sockets).toHaveLength(2);
      answer("signed_out");
      await settle();
      h.last().opened();
      h.last().hello();
      expect(h.states.at(-1)).toBe("open"); // the old answer did not stop this run
      expect(h.last().closedWith).toEqual([]);
    });
  });
});
