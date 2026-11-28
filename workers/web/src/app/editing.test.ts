import { describe, expect, it, vi } from "vitest";
import type { FeedChange, FeedList, FeedTask } from "../sync/feed.ts";
import type { Mutation, SendResult } from "../sync/mutation.ts";
import { MirrorStore } from "../sync/store.ts";
import { type BffFetch, SignedOutError } from "./api.ts";
import { CLIENT_ID_KEY, MutationsHttpError, createEditing, flushWithin, sendMutations, watchOnline } from "./editing.ts";

function taskData(over: Partial<FeedTask> = {}): FeedTask {
  return {
    list_id: "L1", title: "T", status: "notStarted", body: null, importance: "normal", categories: [],
    due: null, start: null, reminder: { on: false, at: null }, completed_at: null, recurrence: null,
    created_at: null, modified_at: null, order: null,
    my_day: { committed_day: null, committed_order: null, postponed_day: null },
    subresources_complete: true, steps: [], links: [], attachments: [], ...over,
  };
}
function listData(over: Partial<FeedList> = {}): FeedList {
  return {
    name: "L", sync: "todo", wellknown: null, is_owner: true, is_shared: false, group_id: null,
    sort_key: null, theme: { color: null, background: null }, image_id: null, image_style: null, ...over,
  };
}
const task = (id: string, over: Partial<FeedTask> = {}): FeedChange => ({
  kind: "task", id, seq: 1, deleted: false, data: taskData(over), field_clock: {},
});
const list = (id: string, over: Partial<FeedList> = {}): FeedChange => ({
  kind: "list", id, seq: 1, deleted: false, data: listData(over),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const applied = (batch: Mutation[]): SendResult => ({
  cursor: "c",
  results: batch.map((m) => ({ id: m.id, status: "applied" as const })),
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
  };
}

/** A session stand-in: markSignedOut runs the listeners, as endSession does. */
function fakeSession() {
  const listeners: Array<() => void> = [];
  return {
    onSignedOut(cb: () => void) {
      listeners.push(cb);
      return () => void listeners.splice(listeners.indexOf(cb), 1);
    },
    end() {
      for (const cb of [...listeners]) cb();
    },
  };
}

interface Posted {
  path: string;
  method?: string;
  body: { client_id: string; mutations: Mutation[] };
}

function setup(opts: { answer?: (body: Posted["body"]) => Response | Promise<Response>; storage?: ReturnType<typeof memoryStorage> | null } = {}) {
  const store = new MirrorStore();
  store.applyPage([list("L1"), list("DEF", { wellknown: "defaultList" }), task("t1")]);
  const posted: Posted[] = [];
  const answer = opts.answer ?? ((b) => json(applied(b.mutations)));
  const bff: BffFetch = async (path, init) => {
    const body = JSON.parse(init?.body ?? "null") as Posted["body"];
    posted.push({ path, method: init?.method, body });
    return answer(body);
  };
  let today = "2026-11-26";
  const loader = { today: vi.fn(() => today), pullAfter: vi.fn(async () => {}) };
  const session = fakeSession();
  const storage = opts.storage === undefined ? memoryStorage() : opts.storage;
  let n = 0;
  const editing = createEditing({
    bff,
    store,
    loader,
    session,
    storage,
    random: () => `u${++n}`,
    now: () => new Date("2026-11-27T12:00:00.000Z"),
    schedule: () => () => {}, // timers never fire; tests flush
  });
  return { store, posted, loader, session, storage, editing, setToday: (d: string) => (today = d) };
}

describe("createEditing: send", () => {
  it("posts {client_id, mutations} to sync/mutations", async () => {
    const { editing, posted } = setup();
    editing.edits.setCompleted("t1", true);
    await editing.outbox.flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe("sync/mutations");
    expect(posted[0]!.method).toBe("POST");
    expect(posted[0]!.body.client_id).toMatch(/^web-/);
    expect(posted[0]!.body.mutations).toEqual([
      { id: expect.any(String), at: "2026-11-27T12:00:00.000Z", op: "task.update", sid: "t1", fields: { status: "completed" } },
    ]);
    expect(editing.outbox.pending()).toEqual([]);
  });

  it("pulls after an answered batch with a pull that starts after the answer", async () => {
    const { editing, loader } = setup();
    editing.edits.rename("t1", "New");
    await editing.outbox.flush();
    expect(loader.pullAfter).toHaveBeenCalledTimes(1);
  });
});

describe("createEditing: client_id", () => {
  it("is made once as web-<uuid>, kept in potem.client_id, and reused", async () => {
    const storage = memoryStorage();
    const first = setup({ storage });
    first.editing.edits.rename("t1", "A");
    await first.editing.outbox.flush();
    const id = first.posted[0]!.body.client_id;
    expect(id).toMatch(/^web-u\d+$/);
    expect(storage.data.get(CLIENT_ID_KEY)).toBe(id);
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    const second = setup({ storage });
    second.editing.edits.rename("t1", "B");
    await second.editing.outbox.flush();
    expect(second.posted[0]!.body.client_id).toBe(id);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("replaces a stored value that isn't a web- id", async () => {
    const storage = memoryStorage({ [CLIENT_ID_KEY]: "mac-123" });
    const { editing, posted } = setup({ storage });
    editing.edits.rename("t1", "A");
    await editing.outbox.flush();
    expect(posted[0]!.body.client_id).toMatch(/^web-/);
    expect(storage.data.get(CLIENT_ID_KEY)).toBe(posted[0]!.body.client_id);
  });

  it("works for the page when storage throws or is missing", async () => {
    const broken = {
      data: new Map<string, string>(),
      getItem: vi.fn(() => {
        throw new Error("SecurityError");
      }),
      setItem: vi.fn(() => {
        throw new Error("QuotaExceededError");
      }),
    };
    for (const storage of [broken, null]) {
      const { editing, posted } = setup({ storage });
      editing.edits.rename("t1", "A");
      editing.edits.rename("t1", "B");
      await editing.outbox.flush();
      expect(posted[0]!.body.client_id).toMatch(/^web-/);
    }
  });
});

describe("createEditing: errors", () => {
  it.each([400, 403, 413, 415])("HTTP %i is permanent: the single refused edit leaves through a notice", async (status) => {
    const { editing } = setup({ answer: () => json({ error: "bad" }, status) });
    editing.edits.rename("t1", "A");
    await editing.outbox.flush();
    expect(editing.outbox.pending()).toEqual([]);
    expect(editing.notices.list()).toEqual([
      { id: expect.any(Number), op: "task.update", sid: "t1", error: "refused" },
    ]);
  });

  it.each([500, 502, 429])("HTTP %i is not permanent: the edit stays queued", async (status) => {
    const { editing } = setup({ answer: () => json({}, status) });
    editing.edits.rename("t1", "A");
    await editing.outbox.flush();
    expect(editing.outbox.pending()).toHaveLength(1);
    expect(editing.notices.list()).toEqual([]);
  });

  it("a request that timed out is retried: the edit stays queued, with no notice", async () => {
    const { editing } = setup({
      answer: () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });
    editing.edits.rename("t1", "A");
    await editing.outbox.flush();
    expect(editing.outbox.pending()).toHaveLength(1);
    expect(editing.notices.list()).toEqual([]);
  });

  it("sendMutations throws a MutationsHttpError carrying the status of a non-OK answer", async () => {
    const bff: BffFetch = async () => json({ error: "too big" }, 413);
    const err = await sendMutations(bff, "web-1", []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MutationsHttpError);
    expect((err as MutationsHttpError).status).toBe(413);
  });

  it("sendMutations returns the §5.3 body of an OK answer", async () => {
    const bff: BffFetch = async () => json({ cursor: "c", results: [] });
    await expect(sendMutations(bff, "web-1", [])).resolves.toEqual({ cursor: "c", results: [] });
  });

  it("a SignedOutError stops the outbox and keeps the edits for the count", async () => {
    const { editing } = setup({
      answer: () => {
        throw new SignedOutError();
      },
    });
    editing.edits.rename("t1", "A");
    await editing.outbox.flush();
    expect(editing.outbox.pending()).toHaveLength(1);
    editing.edits.rename("t1", "B");
    await editing.outbox.flush();
    expect(editing.outbox.pending()).toHaveLength(2);
  });
});

describe("createEditing: overlay", () => {
  it("gives the store the pending edits with {today, defaultListId} on every outbox change", () => {
    const { editing, store } = setup();
    const spy = vi.spyOn(store, "setPending");
    editing.edits.rename("t1", "Shown at once");
    expect(spy).toHaveBeenLastCalledWith(editing.outbox.pending(), { today: "2026-11-26", defaultListId: "DEF" });
    expect(store.task("t1")?.title).toBe("Shown at once");
    expect(store.baseTask("t1")?.title).toBe("T");
  });

  it("refreshContext passes a new today to the store", () => {
    const { editing, store, setToday } = setup();
    editing.edits.rename("t1", "A");
    const spy = vi.spyOn(store, "setPending");
    setToday("2026-11-27");
    editing.refreshContext();
    expect(spy).toHaveBeenCalledWith(editing.outbox.pending(), { today: "2026-11-27", defaultListId: "DEF" });
  });

  it("refreshContext does nothing when neither today nor the default list changed", () => {
    const { editing, store } = setup();
    editing.edits.rename("t1", "A");
    const spy = vi.spyOn(store, "setPending");
    editing.refreshContext();
    expect(spy).not.toHaveBeenCalled();
  });

  it("follows the default list when the lists arrive after creation", () => {
    const store = new MirrorStore();
    const editing = createEditing({
      bff: async () => json({}),
      store,
      loader: { today: () => "2026-11-26", pullAfter: async () => {} },
      session: fakeSession(),
      storage: null,
      random: () => "u",
      now: () => new Date(),
      schedule: () => () => {},
    });
    const spy = vi.spyOn(store, "setPending");
    store.applyPage([list("DEF", { wellknown: "defaultList" })]);
    expect(spy).toHaveBeenLastCalledWith(editing.outbox.pending(), { today: "2026-11-26", defaultListId: "DEF" });
  });
});

describe("createEditing: sign-out", () => {
  it("discards the outbox and keeps the count for the signed-out screen", () => {
    const { editing, session } = setup();
    expect(editing.discarded()).toBeNull();
    editing.edits.rename("t1", "A");
    editing.edits.setImportant("t1", true);
    session.end();
    expect(editing.outbox.pending()).toEqual([]);
    expect(editing.discarded()).toBe(2);
  });

  it("the count is there for a signed-out listener registered later (the app's)", () => {
    const { editing, session } = setup();
    editing.edits.rename("t1", "A");
    let seen: number | null = null;
    session.onSignedOut(() => (seen = editing.discarded()));
    session.end();
    expect(seen).toBe(1);
  });

  it("ignores edits made after sign-out: nothing is queued or sent", async () => {
    const { editing, session, posted } = setup();
    session.end();
    editing.edits.rename("t1", "A");
    editing.edits.setMyDay("t1", true);
    expect(editing.outbox.pending()).toEqual([]);
    await editing.outbox.flush();
    expect(posted).toEqual([]);
    expect(editing.discarded()).toBe(0);
  });

  it("counts zero when nothing was pending", () => {
    const { editing, session } = setup();
    session.end();
    expect(editing.discarded()).toBe(0);
  });
});

describe("createEditing: notices", () => {
  it("a rejected edit becomes a notice naming the op; dismiss removes it", async () => {
    const { editing } = setup({
      answer: (b) => json({ cursor: "c", results: b.mutations.map((m) => ({ id: m.id, status: "rejected", error: "deleted" })) }),
    });
    const seen = vi.fn();
    editing.notices.subscribe(seen);
    editing.edits.remove("t1");
    await editing.outbox.flush();
    const [n] = editing.notices.list();
    expect(n).toEqual({ id: expect.any(Number), op: "task.delete", sid: "t1", error: "deleted" });
    expect(seen).toHaveBeenCalledTimes(1);
    editing.notices.dismiss(n!.id);
    expect(editing.notices.list()).toEqual([]);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe("createEditing: superseded and refused notes", () => {
  it("superseded_fields on an applied result become a notice naming the fields", async () => {
    const { editing } = setup({
      answer: (b) =>
        json({ cursor: "c", results: b.mutations.map((m) => ({ id: m.id, status: "applied", sid: m.sid, superseded_fields: ["title"] })) }),
    });
    editing.edits.rename("t1", "A");
    await editing.outbox.flush();
    expect(editing.notices.list()).toEqual([
      { id: expect.any(Number), op: "task.update", sid: "t1", error: "superseded", fields: ["title"] },
    ]);
  });

  it("a refused note keeps the text, so the notice can copy it", async () => {
    const { editing } = setup({
      answer: (b) => json({ cursor: "c", results: b.mutations.map((m) => ({ id: m.id, status: "rejected", error: "invalid_field:body" })) }),
    });
    editing.edits.setNotes("t1", "Line one\nLine two");
    await editing.outbox.flush();
    expect(editing.notices.list()).toEqual([
      { id: expect.any(Number), op: "task.update", sid: "t1", error: "invalid_field:body", recoverText: "Line one\nLine two" },
    ]);
  });

  it("a note too large to send keeps the text too", async () => {
    const { editing } = setup();
    const big = "x".repeat(200 * 1024);
    editing.edits.setNotes("t1", big);
    await editing.outbox.flush();
    expect(editing.notices.list()).toEqual([
      { id: expect.any(Number), op: "task.update", sid: "t1", error: "too_large", recoverText: big },
    ]);
  });

  it("a note that can't be saved here (task gone) becomes a notice carrying the typed text", () => {
    const { editing } = setup();
    editing.edits.setNotes("gone", "My typed note");
    expect(editing.outbox.pending()).toEqual([]);
    expect(editing.notices.list()).toEqual([
      { id: expect.any(Number), op: "task.update", sid: "gone", error: "note_changed", recoverText: "My typed note" },
    ]);
  });

  it("a refused edit that emptied the note has no text to copy", async () => {
    const { editing } = setup({
      answer: (b) => json({ cursor: "c", results: b.mutations.map((m) => ({ id: m.id, status: "rejected", error: "deleted" })) }),
    });
    editing.edits.setNotes("t1", "");
    await editing.outbox.flush();
    expect(editing.notices.list()).toHaveLength(1);
    expect(editing.notices.list()[0]).not.toHaveProperty("recoverText");
  });

  it("a refused rename has no text to copy", async () => {
    const { editing } = setup({
      answer: (b) => json({ cursor: "c", results: b.mutations.map((m) => ({ id: m.id, status: "rejected", error: "deleted" })) }),
    });
    editing.edits.rename("t1", "A");
    await editing.outbox.flush();
    expect(editing.notices.list()[0]).not.toHaveProperty("recoverText");
  });
});

describe("flushWithin (sign-out)", () => {
  const edit: Mutation = { id: "m1", at: "2026-11-27T12:00:00.000Z", op: "task.update", sid: "t1", fields: { title: "A" } };
  function fakeTimers() {
    const timers: { fn: () => void; ms: number }[] = [];
    return { timers, schedule: (fn: () => void, ms: number) => (timers.push({ fn, ms }), () => {}) };
  }

  it("resolves when the flush finishes", async () => {
    const t = fakeTimers();
    let done = false;
    await flushWithin({ unsent: () => [edit], flush: async () => void (done = true) }, 3000, t.schedule);
    expect(done).toBe(true);
  });

  it("gives up after 3 s when the flush hangs", async () => {
    const t = fakeTimers();
    let resolved = false;
    const p = flushWithin({ unsent: () => [edit], flush: () => new Promise<void>(() => {}) }, 3000, t.schedule).then(() => (resolved = true));
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(t.timers.map((x) => x.ms)).toEqual([3000]);
    t.timers[0]!.fn();
    await p;
    expect(resolved).toBe(true);
  });

  it("resolves at once with nothing unsent, without waiting on a pull retry", async () => {
    const t = fakeTimers();
    let flushed = false;
    await flushWithin({ unsent: () => [], flush: () => ((flushed = true), new Promise<void>(() => {})) }, 3000, t.schedule);
    expect(flushed).toBe(false);
    expect(t.timers).toEqual([]);
  });

  it("resolves when the flush throws", async () => {
    const t = fakeTimers();
    await expect(flushWithin({ unsent: () => [edit], flush: async () => Promise.reject(new Error("x")) }, 3000, t.schedule)).resolves.toBeUndefined();
  });

  it("a sign-out after it counts only what is still unsent", async () => {
    const { editing, session } = setup();
    editing.edits.rename("t1", "A");
    await flushWithin(editing.outbox, 3000, () => () => {});
    session.end();
    expect(editing.discarded()).toBe(0);
  });
});

describe("watchOnline", () => {
  it("flushes the outbox when the browser comes back online, until stopped", () => {
    const target = new EventTarget();
    const flush = vi.fn(async () => {});
    const stop = watchOnline({ flush }, target);
    target.dispatchEvent(new Event("online"));
    expect(flush).toHaveBeenCalledTimes(1);
    stop();
    target.dispatchEvent(new Event("online"));
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe("createEditing: page notices", () => {
  it("add shows a notice the page raised itself", () => {
    const { editing } = setup();
    editing.notices.add({ op: "task.create", sid: "", error: "no_default_list" });
    expect(editing.notices.list()).toEqual([{ id: expect.any(Number), op: "task.create", sid: "", error: "no_default_list" }]);
  });
});
