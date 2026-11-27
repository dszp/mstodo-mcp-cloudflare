// sync/coalesce.ts: one `changed` per burst (docs/SYNC-API.md section 7.1).
import { describe, it, expect } from "vitest";
import { coalescing, type Timers } from "@potem/core/sync/coalesce";

function clock() {
  let now = 1_000_000;
  const pending: Array<{ at: number; fn: () => void; id: number }> = [];
  let next = 1;
  const timers: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = pending.findIndex((p) => p.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const p of pending.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) {
      pending.splice(pending.indexOf(p), 1);
      p.fn();
    }
  };
  return { timers, advance, pending };
}

function setup() {
  const c = clock();
  const sent: string[] = [];
  const closed: string[] = [];
  const n = coalescing({ announce: (x) => sent.push(x), closeAll: (r) => closed.push(r), sweep: () => {} }, 3000, c.timers);
  return { ...c, n, sent, closed };
}

describe("coalescing", () => {
  it("sends a lone change at once", () => {
    const s = setup();
    s.n.announce("e.1");
    expect(s.sent).toEqual(["e.1"]);
    expect(s.pending).toHaveLength(0);
  });

  it("holds changes inside the window and sends the newest when it ends", () => {
    const s = setup();
    s.n.announce("e.1");
    s.advance(40);
    s.n.announce("e.2");
    s.advance(2200);
    s.n.announce("e.3");
    expect(s.sent).toEqual(["e.1"]);
    s.advance(759);
    expect(s.sent).toEqual(["e.1"]);
    s.advance(1);
    expect(s.sent).toEqual(["e.1", "e.3"]);
  });

  it("a change right after a held send waits for the next window", () => {
    const s = setup();
    s.n.announce("e.1");
    s.n.announce("e.2");
    s.advance(3000);
    expect(s.sent).toEqual(["e.1", "e.2"]);
    s.n.announce("e.3");
    expect(s.sent).toHaveLength(2);
    s.advance(3000);
    expect(s.sent).toEqual(["e.1", "e.2", "e.3"]);
  });

  it("sends at once again after a quiet window", () => {
    const s = setup();
    s.n.announce("e.1");
    s.advance(3000);
    s.n.announce("e.2");
    expect(s.sent).toEqual(["e.1", "e.2"]);
  });

  it("drops a held change when the sockets close", () => {
    const s = setup();
    s.n.announce("e.1");
    s.n.announce("e.2");
    s.n.closeAll("reset");
    s.advance(10_000);
    expect(s.sent).toEqual(["e.1"]);
    expect(s.closed).toEqual(["reset"]);
  });
});
