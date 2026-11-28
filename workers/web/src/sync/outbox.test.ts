import { describe, expect, it } from "vitest";
import type { Mutation, MutationResult, SendResult } from "./mutation";
import { type OutboxDeps, createOutbox } from "./outbox";

class SignedOut extends Error {}
class Permanent extends Error {}

// A virtual clock behind the injected schedule: timers fire only when tick()
// passes their due time, so every delay the outbox asks for is observable.
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
    now: () => now,
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

type Responder = (batch: Mutation[]) => SendResult | Error;

function harness(respond: Responder = (b) => answer(b, "applied")) {
  const clock = fakeClock();
  const sent: string[][] = [];
  const sentBytes: number[] = [];
  let pulls = 0;
  let n = 0;
  let responder = respond;
  let pullFails: () => Error | null = () => null;
  const deps: OutboxDeps = {
    async send(batch) {
      sent.push(batch.map((m) => m.id));
      sentBytes.push(JSON.stringify(batch).length);
      const r = responder(batch);
      if (r instanceof Error) throw r;
      return r;
    },
    async pull() {
      pulls += 1;
      const e = pullFails();
      if (e) throw e;
    },
    // The device clock follows the virtual one.
    now: () => new Date(Date.UTC(2026, 10, 27, 12, 0, 0) + clock.now()),
    random: () => `m-${++n}`,
    schedule: clock.schedule,
    isSignedOut: (e) => e instanceof SignedOut,
    isPermanent: (e) => e instanceof Permanent,
  };
  const outbox = createOutbox(deps);
  return {
    outbox,
    clock,
    sent,
    sentBytes,
    pulls: () => pulls,
    respondWith(r: Responder) {
      responder = r;
    },
    pullWith(f: () => Error | null) {
      pullFails = f;
    },
  };
}

function answer(batch: Mutation[], status: "applied" | "duplicate" | "skipped"): SendResult {
  return { cursor: "c1", results: batch.map((m) => ({ id: m.id, status, sid: m.sid }) as MutationResult) };
}

const edit = (sid: string) => ({ op: "task.update" as const, sid, fields: { title: sid } });

describe("outbox", () => {
  it("stores an edit with an id and the device time", () => {
    const { outbox } = harness();
    const m = outbox.enqueue(edit("t1"));
    expect(m).toEqual({ id: "m-1", at: "2026-11-27T12:00:00.000Z", op: "task.update", sid: "t1", fields: { title: "t1" } });
    expect(outbox.pending()).toEqual([m]);
  });

  it("sends 300 ms after the first edit, with every edit from that window in one batch", async () => {
    const h = harness();
    h.outbox.enqueue(edit("t1"));
    await h.clock.tick(200);
    h.outbox.enqueue(edit("t2"));
    await h.clock.tick(99);
    expect(h.sent).toEqual([]);
    await h.clock.tick(1);
    expect(h.sent).toEqual([["m-1", "m-2"]]);
    expect(h.outbox.pending()).toEqual([]);
  });

  it("batches at 25, in queue order", async () => {
    const h = harness();
    for (let i = 1; i <= 60; i++) h.outbox.enqueue(edit(`t${i}`));
    await h.outbox.flush();
    expect(h.sent.map((b) => b.length)).toEqual([25, 25, 10]);
    expect(h.sent.flat()).toEqual(Array.from({ length: 60 }, (_, i) => `m-${i + 1}`));
    expect(h.outbox.pending()).toEqual([]);
    expect(h.pulls()).toBe(3);
  });

  it("never has two requests in flight; a flush during a send joins it", async () => {
    const clock = fakeClock();
    let open = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    let n = 0;
    const outbox = createOutbox({
      send(batch) {
        open += 1;
        most = Math.max(most, open);
        return new Promise<SendResult>((resolve) => {
          releases.push(() => {
            open -= 1;
            resolve(answer(batch, "applied"));
          });
        });
      },
      pull: async () => {},
      now: () => new Date(0),
      random: () => `m-${++n}`,
      schedule: clock.schedule,
      isSignedOut: () => false,
      isPermanent: () => false,
    });
    outbox.enqueue(edit("t1"));
    const first = outbox.flush();
    await settle();
    outbox.enqueue(edit("t2")); // waits for the next batch
    const second = outbox.flush();
    await clock.tick(300); // the debounce timer fires while the send is open
    expect(releases).toHaveLength(1);
    releases[0]!();
    await settle();
    expect(releases).toHaveLength(2); // t2 goes next, in its own batch
    releases[1]!();
    await Promise.all([first, second]);
    expect(most).toBe(1);
    expect(outbox.pending()).toEqual([]);
  });

  it("keeps edits to one task in order across batches", async () => {
    const h = harness();
    h.outbox.enqueue({ op: "task.update", sid: "t1", fields: { status: "completed" } });
    h.outbox.enqueue({ op: "task.update", sid: "t1", fields: { status: "notStarted" } });
    await h.outbox.flush();
    expect(h.sent).toEqual([["m-1", "m-2"]]);
  });

  it("drops applied and duplicate, rejects rejected and failed retry:false, keeps failed retry:true and skipped", async () => {
    const h = harness((b) => ({
      cursor: "c2",
      results: [
        { id: b[0]!.id, status: "applied", sid: "t1" },
        { id: b[1]!.id, status: "duplicate", sid: "t2" },
        { id: b[2]!.id, status: "rejected", error: "deleted" },
        { id: b[3]!.id, status: "failed", error: "bad_thing", retry: false },
        { id: b[4]!.id, status: "failed", error: "graph_unavailable", retry: true },
        { id: b[5]!.id, status: "skipped" },
      ],
    }));
    const rejected: [string, unknown][] = [];
    h.outbox.onRejected((m, e) => rejected.push([m.sid, e]));
    for (const s of ["t1", "t2", "t3", "t4", "t5", "t6"]) h.outbox.enqueue(edit(s));
    await h.outbox.flush();
    expect(h.outbox.pending().map((m) => m.sid)).toEqual(["t5", "t6"]);
    expect(rejected).toEqual([
      ["t3", { error: "deleted" }],
      ["t4", { error: "bad_thing", retry: false }],
    ]);
  });

  it("keeps a sent mutation the results leave out, and ignores results for ids it never sent", async () => {
    const h = harness(() => ({
      cursor: "c2",
      results: [
        { id: "m-1", status: "applied", sid: "t1" },
        { id: "m-unknown", status: "rejected", error: "deleted" },
      ],
    }));
    const rejected: unknown[] = [];
    h.outbox.onRejected((m) => rejected.push(m));
    h.outbox.enqueue(edit("t1"));
    h.outbox.enqueue(edit("t2"));
    await h.outbox.flush();
    // m-1 went through, so m-2 is resent at once; that answer removes nothing,
    // so the outbox backs off.
    expect(h.sent).toEqual([["m-1", "m-2"], ["m-2"]]);
    expect(h.outbox.pending().map((m) => m.sid)).toEqual(["t2"]);
    expect(h.clock.waiting()).toEqual([1000]);
    expect(rejected).toEqual([]);
  });

  it("retries keep ids: a thrown send is retried with the same mutations", async () => {
    const h = harness(() => new Error("network"));
    h.outbox.enqueue({ op: "task.create", sid: "t1", fields: { list_id: "l1", title: "Example" } });
    await h.outbox.flush();
    expect(h.outbox.pending()).toHaveLength(1);
    h.respondWith((b) => answer(b, "duplicate"));
    await h.clock.tick(1000);
    expect(h.sent).toEqual([["m-1"], ["m-1"]]);
    expect(h.outbox.pending()).toEqual([]);
  });

  it("backs off 1 s, 2 s, 4 s … capped at 30 s, and resets after a batch goes through", async () => {
    const h = harness(() => new Error("503"));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const [wait] = h.clock.waiting();
      delays.push(wait!);
      await h.clock.tick(wait!);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(h.sent).toHaveLength(8);
    expect(new Set(h.sent.flat())).toEqual(new Set(["m-1"]));

    h.respondWith((b) => answer(b, "applied"));
    await h.clock.tick(30000);
    expect(h.outbox.pending()).toEqual([]);

    h.respondWith(() => new Error("503"));
    h.outbox.enqueue(edit("t2"));
    await h.outbox.flush();
    expect(h.clock.waiting()).toEqual([1000]);
  });

  it("a new edit during a backoff gets the normal 300 ms window, resending the head with it", async () => {
    const h = harness(() => new Error("network"));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    for (let i = 0; i < 4; i++) await h.clock.tick(h.clock.waiting()[0]!);
    expect(h.clock.waiting()).toEqual([16000]);
    h.respondWith((b) => answer(b, "applied"));
    h.outbox.enqueue(edit("t2"));
    expect(h.clock.waiting()).toEqual([300]);
    await h.clock.tick(300);
    expect(h.sent.at(-1)).toEqual(["m-1", "m-2"]);
    expect(h.outbox.pending()).toEqual([]);
  });

  it("a new edit during a backoff that fails again backs off longer, not from the start", async () => {
    const h = harness(() => new Error("network"));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    await h.clock.tick(1000); // second failure: 2 s
    h.outbox.enqueue(edit("t2"));
    await h.clock.tick(300);
    expect(h.clock.waiting()).toEqual([4000]);
  });

  it("gives up on a mutation answered failed with retry the sixth time: onRejected with its last error", async () => {
    let call = 0;
    const h = harness((b) => ({
      cursor: "c",
      results: b.map((m) => ({ id: m.id, status: "failed" as const, error: `graph_unavailable_${++call}`, retry: true })),
    }));
    const rejected: [string, unknown][] = [];
    h.outbox.onRejected((m, e) => rejected.push([m.id, e]));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    for (let i = 0; i < 4; i++) await h.clock.tick(h.clock.waiting()[0]!);
    expect(h.sent).toHaveLength(5);
    expect(rejected).toEqual([]);
    await h.clock.tick(h.clock.waiting()[0]!);
    expect(h.sent).toHaveLength(6);
    expect(rejected).toEqual([["m-1", { error: "graph_unavailable_6" }]]);
    expect(h.outbox.pending()).toEqual([]);
    expect(h.clock.waiting()).toEqual([]);
  });

  it("gives up on a mutation still answered failed with retry more than 5 minutes after its first failure", async () => {
    let failNext = true;
    const h = harness((b) =>
      failNext
        ? { cursor: "c", results: b.map((m) => ({ id: m.id, status: "failed" as const, error: "graph_unavailable", retry: true })) }
        : new Error("network"),
    );
    const rejected: [string, unknown][] = [];
    h.outbox.onRejected((m, e) => rejected.push([m.id, e]));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    // Thrown sends don't count as failed answers; only time passes.
    failNext = false;
    while (h.clock.now() < 5 * 60_000) await h.clock.tick(h.clock.waiting()[0]!);
    expect(rejected).toEqual([]);
    failNext = true;
    await h.clock.tick(h.clock.waiting()[0]!);
    expect(rejected).toEqual([["m-1", { error: "graph_unavailable" }]]);
    expect(h.outbox.pending()).toEqual([]);
  });

  it("a duplicate carrying a stored rejected result is rejected with the stored error", async () => {
    const h = harness((b) => ({
      cursor: "c",
      results: [{ id: b[0]!.id, status: "duplicate", result: { id: b[0]!.id, status: "rejected", error: "deleted" } }],
    }));
    const rejected: [string, unknown][] = [];
    h.outbox.onRejected((m, e) => rejected.push([m.id, e]));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    expect(rejected).toEqual([["m-1", { error: "deleted" }]]);
    expect(h.outbox.pending()).toEqual([]);
  });

  it("reports superseded_fields of an applied result, or of a duplicate's stored applied result", async () => {
    const h = harness((b) => ({
      cursor: "c",
      results: [
        { id: b[0]!.id, status: "applied", sid: "t1", superseded_fields: ["title"] },
        { id: b[1]!.id, status: "duplicate", result: { id: b[1]!.id, status: "applied", sid: "t2", superseded_fields: ["due", "importance"] } },
        { id: b[2]!.id, status: "applied", sid: "t3", superseded_fields: [] },
        { id: b[3]!.id, status: "duplicate" },
      ],
    }));
    const superseded: [string, string[]][] = [];
    const rejected: unknown[] = [];
    h.outbox.onSuperseded((m, fields) => superseded.push([m.id, fields]));
    h.outbox.onRejected((m) => rejected.push(m));
    for (const s of ["t1", "t2", "t3", "t4"]) h.outbox.enqueue(edit(s));
    await h.outbox.flush();
    expect(superseded).toEqual([
      ["m-1", ["title"]],
      ["m-2", ["due", "importance"]],
    ]);
    expect(rejected).toEqual([]);
    expect(h.outbox.pending()).toEqual([]);
  });

  it("skipped retried: kept, backed off, and sent again in order", async () => {
    const h = harness((b) => ({
      cursor: "c2",
      results: [
        { id: b[0]!.id, status: "failed", error: "graph_unavailable", retry: true },
        { id: b[1]!.id, status: "skipped" },
      ],
    }));
    h.outbox.enqueue({ op: "task.create", sid: "t1", fields: { list_id: "l1", title: "Example" } });
    h.outbox.enqueue({ op: "task.update", sid: "t1", fields: { importance: "high" } });
    await h.outbox.flush();
    expect(h.outbox.pending().map((m) => m.id)).toEqual(["m-1", "m-2"]);
    expect(h.clock.waiting()).toEqual([1000]);
    h.respondWith((b) => answer(b, "applied"));
    await h.clock.tick(1000);
    expect(h.sent).toEqual([["m-1", "m-2"], ["m-1", "m-2"]]);
    expect(h.outbox.pending()).toEqual([]);
  });

  it("pulls after each answered batch, before the sent edits leave pending()", async () => {
    const seen: number[] = [];
    let pending = 0;
    const clock = fakeClock();
    let n = 0;
    const outbox = createOutbox({
      send: async (b) => answer(b, "applied"),
      pull: async () => {
        seen.push(pending);
      },
      now: () => new Date(0),
      random: () => `m-${++n}`,
      schedule: clock.schedule,
      isSignedOut: () => false,
      isPermanent: () => false,
    });
    outbox.subscribe(() => {
      pending = outbox.pending().length;
    });
    for (let i = 0; i < 30; i++) outbox.enqueue(edit(`t${i}`));
    await outbox.flush();
    // Two batches, two pulls; each pull ran while that batch was still pending,
    // so the overlay never drops an edit before the mirror has it.
    expect(seen).toEqual([30, 5]);
  });

  it("does not pull after a thrown send", async () => {
    const h = harness(() => new Error("network"));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    expect(h.pulls()).toBe(0);
  });

  it("when the pull after an answer fails, keeps the applied edits in pending() and retries the pull after 2 s, then backs off", async () => {
    const h = harness();
    let failing = true;
    h.pullWith(() => (failing ? new Error("pull failed") : null));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    // Sent and applied, but the mirror hasn't caught up: the overlay keeps it.
    expect(h.sent).toEqual([["m-1"]]);
    expect(h.outbox.pending().map((m) => m.id)).toEqual(["m-1"]);
    expect(h.outbox.unsent()).toEqual([]);
    expect(h.clock.waiting()).toEqual([2000]);
    await h.clock.tick(2000);
    expect(h.pulls()).toBe(2);
    expect(h.clock.waiting()).toEqual([4000]);
    failing = false;
    await h.clock.tick(4000);
    expect(h.pulls()).toBe(3);
    expect(h.outbox.pending()).toEqual([]);
    expect(h.clock.waiting()).toEqual([]);
    expect(h.sent).toEqual([["m-1"]]); // never resent
  });

  it("a rejected result leaves pending() even when the pull fails", async () => {
    const h = harness((b) => ({ cursor: "c", results: [{ id: b[0]!.id, status: "rejected", error: "deleted" }] }));
    h.pullWith(() => new Error("pull failed"));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    expect(h.outbox.pending()).toEqual([]);
  });

  it("a later batch's successful pull also clears edits an earlier failed pull left behind", async () => {
    const h = harness();
    let failing = true;
    h.pullWith(() => (failing ? new Error("pull failed") : null));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    failing = false;
    h.outbox.enqueue(edit("t2"));
    expect(h.outbox.pending().map((m) => m.id)).toEqual(["m-1", "m-2"]);
    await h.outbox.flush();
    expect(h.outbox.pending()).toEqual([]);
    expect(h.clock.waiting()).toEqual([]);
  });

  it("discard counts only unsent edits, and drops the ones awaiting a pull", async () => {
    const h = harness();
    h.pullWith(() => new Error("pull failed"));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    h.respondWith(() => new Error("network"));
    h.outbox.enqueue(edit("t2"));
    await h.outbox.flush();
    expect(h.outbox.pending().map((m) => m.id)).toEqual(["m-1", "m-2"]);
    expect(h.outbox.discard()).toBe(1);
    expect(h.outbox.pending()).toEqual([]);
    expect(h.clock.waiting()).toEqual([]);
  });

  it("flush with nothing unsent retries a failed pull at once", async () => {
    const h = harness();
    let failing = true;
    h.pullWith(() => (failing ? new Error("pull failed") : null));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    failing = false;
    await h.outbox.flush();
    expect(h.pulls()).toBe(2);
    expect(h.outbox.pending()).toEqual([]);
    expect(h.clock.waiting()).toEqual([]);
  });

  it("keeps sending when pull throws", async () => {
    const clock = fakeClock();
    let n = 0;
    const sent: number[] = [];
    const outbox = createOutbox({
      send: async (b) => {
        sent.push(b.length);
        return answer(b, "applied");
      },
      pull: async () => {
        throw new Error("pull failed");
      },
      now: () => new Date(0),
      random: () => `m-${++n}`,
      schedule: clock.schedule,
      isSignedOut: () => false,
      isPermanent: () => false,
    });
    for (let i = 0; i < 26; i++) outbox.enqueue(edit(`t${i}`));
    await outbox.flush();
    expect(sent).toEqual([25, 1]);
    expect(outbox.unsent()).toEqual([]);
    expect(outbox.pending()).toHaveLength(26);
  });

  it("subscribe fires on enqueue, removal and discard", async () => {
    const h = harness();
    let calls = 0;
    const off = h.outbox.subscribe(() => calls++);
    h.outbox.enqueue(edit("t1"));
    expect(calls).toBe(1);
    await h.outbox.flush();
    // Once as the answer takes it out of unsent(), once as the pull takes it
    // out of pending().
    expect(calls).toBe(3);
    h.outbox.enqueue(edit("t2"));
    h.outbox.discard();
    expect(calls).toBe(5);
    off();
    h.outbox.enqueue(edit("t3"));
    expect(calls).toBe(5);
  });

  it("discard returns the count and cancels the timer", async () => {
    const h = harness();
    h.outbox.enqueue(edit("t1"));
    h.outbox.enqueue(edit("t2"));
    expect(h.outbox.discard()).toBe(2);
    expect(h.outbox.pending()).toEqual([]);
    expect(h.clock.waiting()).toEqual([]);
    await h.clock.tick(60000);
    expect(h.sent).toEqual([]);
  });

  it("discard cancels a backoff", async () => {
    const h = harness(() => new Error("network"));
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    expect(h.outbox.discard()).toBe(1);
    expect(h.clock.waiting()).toEqual([]);
  });

  it("sends nothing after SignedOutError", async () => {
    const h = harness(() => new SignedOut());
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    expect(h.clock.waiting()).toEqual([]);
    h.respondWith((b) => answer(b, "applied"));
    h.outbox.enqueue(edit("t2"));
    await h.outbox.flush();
    await h.clock.tick(60000);
    expect(h.sent).toEqual([["m-1"]]);
    expect(h.pulls()).toBe(0);
    // The edits stay until sign-out discards them, so the count can be shown.
    expect(h.outbox.discard()).toBe(2);
  });

  it("sends an edit enqueued while a run is shutting down", async () => {
    const h = harness();
    let once = true;
    h.outbox.subscribe(() => {
      // Two microtasks after the pull empties pending(): the run's loop has
      // returned but the run itself hasn't been cleared yet. (Checked: with
      // the re-arm in flush's finally removed, this test fails.)
      if (once && h.outbox.pending().length === 0) {
        once = false;
        void Promise.resolve().then(() => undefined).then(() => h.outbox.enqueue(edit("t2")));
      }
    });
    h.outbox.enqueue(edit("t1"));
    await h.outbox.flush();
    await settle();
    expect(h.outbox.pending().map((m) => m.id)).toEqual(["m-2"]);
    await h.clock.tick(300);
    expect(h.sent).toEqual([["m-1"], ["m-2"]]);
    expect(h.outbox.pending()).toEqual([]);
  });

  it("caps a batch at 192 KiB of JSON as well as 25 mutations", async () => {
    const h = harness();
    const text = "x".repeat(30 * 1024);
    for (let i = 1; i <= 10; i++) h.outbox.enqueue({ op: "task.update", sid: `t${i}`, fields: { title: text } });
    await h.outbox.flush();
    expect(h.sent.length).toBeGreaterThan(1);
    for (const bytes of h.sentBytes) expect(bytes).toBeLessThanOrEqual(192 * 1024);
    expect(h.sent.flat()).toEqual(Array.from({ length: 10 }, (_, i) => `m-${i + 1}`));
    expect(h.outbox.pending()).toEqual([]);
  });

  it("rejects a mutation larger than a batch as too_large and sends the rest", async () => {
    const h = harness();
    const rejected: [string, unknown][] = [];
    h.outbox.onRejected((m, e) => rejected.push([m.id, e]));
    h.outbox.enqueue(edit("t1"));
    h.outbox.enqueue({ op: "task.update", sid: "t2", fields: { title: "x".repeat(200 * 1024) } });
    h.outbox.enqueue(edit("t3"));
    await h.outbox.flush();
    expect(h.sent).toEqual([["m-1"], ["m-3"]]);
    expect(rejected).toEqual([["m-2", { error: "too_large" }]]);
    expect(h.outbox.pending()).toEqual([]);
  });

  it("splits a permanently refused batch until the one bad edit is found, in order, never resending a batch", async () => {
    const h = harness((b) => (b.some((m) => m.sid === "t3") ? new Permanent("400") : answer(b, "applied")));
    const rejected: [string, unknown][] = [];
    h.outbox.onRejected((m, e) => rejected.push([m.id, e]));
    for (const s of ["t1", "t2", "t3", "t4"]) h.outbox.enqueue(edit(s));
    await h.outbox.flush();
    expect(h.sent).toEqual([["m-1", "m-2", "m-3", "m-4"], ["m-1", "m-2"], ["m-3", "m-4"], ["m-3"], ["m-4"]]);
    expect(rejected).toEqual([["m-3", { error: "refused" }]]);
    expect(h.outbox.pending()).toEqual([]);
    expect(h.clock.waiting()).toEqual([]);
    expect(new Set(h.sent.map((b) => b.join())).size).toBe(h.sent.length);
  });

  it("a batch that made progress without a failure resets the backoff and sends the rest at once", async () => {
    let call = 0;
    const h = harness((b) => {
      call += 1;
      if (call === 1) return new Error("network");
      if (call === 2) return { cursor: "c", results: [{ id: b[0]!.id, status: "applied" }, { id: b[1]!.id, status: "skipped" }] };
      return answer(b, "applied");
    });
    h.outbox.enqueue(edit("t1"));
    h.outbox.enqueue(edit("t2"));
    await h.outbox.flush();
    expect(h.clock.waiting()).toEqual([1000]);
    await h.clock.tick(1000);
    expect(h.sent).toEqual([["m-1", "m-2"], ["m-1", "m-2"], ["m-2"]]);
    expect(h.outbox.pending()).toEqual([]);
    expect(h.clock.waiting()).toEqual([]);
    h.respondWith(() => new Error("network"));
    h.outbox.enqueue(edit("t3"));
    await h.outbox.flush();
    expect(h.clock.waiting()).toEqual([1000]);
  });

  it("a discard while a request is open: no onRejected for discarded edits, no timer left behind", async () => {
    const clock = fakeClock();
    let release: (r: SendResult) => void = () => {};
    let n = 0;
    const outbox = createOutbox({
      send: () => new Promise<SendResult>((r) => (release = r)),
      pull: async () => {},
      now: () => new Date(0),
      random: () => `m-${++n}`,
      schedule: clock.schedule,
      isSignedOut: () => false,
      isPermanent: () => false,
    });
    const rejected: unknown[] = [];
    outbox.onRejected((m) => rejected.push(m));
    outbox.enqueue(edit("t1"));
    outbox.enqueue(edit("t2"));
    const done = outbox.flush();
    await settle();
    expect(outbox.discard()).toBe(2);
    release({
      cursor: "c",
      results: [
        { id: "m-1", status: "rejected", error: "deleted" },
        { id: "m-2", status: "failed", error: "graph_unavailable", retry: true },
      ],
    });
    await done;
    expect(rejected).toEqual([]);
    expect(clock.waiting()).toEqual([]);
    expect(outbox.pending()).toEqual([]);
  });
});
