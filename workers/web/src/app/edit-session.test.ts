import { describe, expect, it } from "vitest";
import { DATE_DEBOUNCE_MS, DateEntry, EditSession, createDirtyRegistry } from "./edit-session.ts";
import { dateInputCommit, noteEdit, titleEdit } from "./model.ts";

function fakeSchedule() {
  let timers: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    schedule(fn: () => void, ms: number) {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    waiting: () => timers.filter((t) => t.live).map((t) => t.ms),
    fire() {
      const due = timers.filter((t) => t.live);
      timers = [];
      for (const t of due) t.fn();
    },
  };
}

describe("dirty registry", () => {
  it("is dirty while any editor says so", () => {
    const r = createDirtyRegistry();
    const a = {};
    const b = {};
    expect(r.any()).toBe(false);
    r.set(a, true);
    r.set(b, false);
    expect(r.any()).toBe(true);
    r.set(a, false);
    expect(r.any()).toBe(false);
    r.set(b, true);
    r.delete(b);
    expect(r.any()).toBe(false);
  });
});

describe("EditSession", () => {
  function session(decide = titleEdit) {
    const commits: string[] = [];
    const registry = createDirtyRegistry();
    const s = new EditSession(decide, registry);
    s.onCommit = (t) => commits.push(t);
    return { s, commits, registry };
  }

  it("compares with the text the box opened with, not the text at commit time", () => {
    // Opened on "Draft", renamed to "Final" on another device while open,
    // left unchanged: sending "Draft" would undo the other device's rename.
    const { s, commits } = session();
    s.open("Draft");
    expect(titleEdit("Final", "Draft")).toBe("Draft"); // what comparing with the prop did
    s.finish(true, "Draft");
    expect(commits).toEqual([]);
  });

  it("saves typed text once, on finish", () => {
    const { s, commits } = session();
    s.open("Draft");
    s.type("Draft 2");
    s.finish(true, "Draft 2");
    s.finish(true, "Draft 2");
    s.close();
    expect(commits).toEqual(["Draft 2"]);
  });

  it("Escape saves nothing, and neither does the unmount after it", () => {
    const { s, commits } = session();
    s.open("Draft");
    s.type("Draft 2");
    s.finish(false);
    s.close();
    expect(commits).toEqual([]);
  });

  it("an unmount while open saves what was typed", () => {
    const { s, commits } = session();
    s.open("Draft");
    s.type("Draft 2");
    s.close();
    expect(commits).toEqual(["Draft 2"]);
  });

  it("an unmount never throws, even when the save does", () => {
    const { s } = session();
    s.onCommit = () => {
      throw new Error("no task to edit");
    };
    s.open("Draft");
    s.type("Draft 2");
    expect(() => s.close()).not.toThrow();
    expect(s.isOpen).toBe(false);
  });

  it("an unmount while open with nothing typed, or the opened text typed back, saves nothing", () => {
    const { s, commits } = session();
    s.open("Draft");
    s.close();
    s.open("Draft");
    s.type("Draft 2");
    s.type("Draft");
    s.close();
    expect(commits).toEqual([]);
  });

  it("marks itself dirty while the typed text would save, and clean once it ends", () => {
    const { s, registry } = session(noteEdit);
    s.open("a");
    expect(registry.any()).toBe(false);
    s.type("ab");
    expect(registry.any()).toBe(true);
    s.type("a");
    expect(registry.any()).toBe(false);
    s.type("abc");
    s.finish(true, "abc");
    expect(registry.any()).toBe(false);
    s.open("abc");
    s.type("abcd");
    s.close();
    expect(registry.any()).toBe(false);
  });
});

describe("dateInputCommit with badInput", () => {
  it("an empty value the browser calls incomplete is not a clear", () => {
    expect(dateInputCommit("", "2026-12-03", (v) => v, true)).toEqual({ kind: "none" });
    expect(dateInputCommit("", "2026-12-03", (v) => v, false)).toEqual({ kind: "clear" });
  });
});

describe("DateEntry", () => {
  const asIs = (v: string) => v;
  function entry(current: string | null = "2026-12-01") {
    const clock = fakeSchedule();
    const registry = createDirtyRegistry();
    const saved: (string | null)[] = [];
    const e = new DateEntry(clock.schedule, registry);
    e.sync(current, asIs, (v) => saved.push(v));
    return { e, clock, registry, saved };
  }

  it("saves a whole, changed value 600 ms after the last change", () => {
    const { e, clock, saved } = entry();
    e.change("2026-12-03", false);
    expect(clock.waiting()).toEqual([DATE_DEBOUNCE_MS]);
    expect(DATE_DEBOUNCE_MS).toBe(600);
    e.change("2026-12-04", false);
    expect(clock.waiting()).toEqual([600]);
    clock.fire();
    expect(saved).toEqual(["2026-12-04"]);
  });

  it("discard drops a pending value without saving, and close afterwards saves nothing", () => {
    const { e, clock, registry, saved } = entry();
    e.change("2026-12-03", false);
    expect(registry.any()).toBe(true);
    e.discard();
    expect(clock.waiting()).toEqual([]);
    expect(registry.any()).toBe(false);
    e.close();
    expect(saved).toEqual([]);
  });

  it("waits for nothing while a value is partial, unchanged, or emptied", () => {
    const { e, clock, saved } = entry();
    e.change("0002-12-03", false);
    e.change("2026-12-01", false);
    e.change("", true);
    e.change("", false);
    expect(clock.waiting()).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("a change back to a partial value drops the waiting save", () => {
    const { e, clock, saved } = entry();
    e.change("2026-12-03", false);
    e.change("", true);
    clock.fire();
    expect(saved).toEqual([]);
  });

  it("blur or Enter saves at once, clearing only an emptied, valid field", () => {
    const { e, clock, saved } = entry();
    e.change("2026-12-03", false);
    expect(e.commit()).toBe(true);
    expect(clock.waiting()).toEqual([]);
    expect(saved).toEqual(["2026-12-03"]);
    e.change("", true);
    expect(e.commit()).toBe(false); // incomplete: put back, nothing sent
    e.change("", false);
    expect(e.commit()).toBe(true);
    expect(saved).toEqual(["2026-12-03", null]);
  });

  it("an unmount saves a waiting value now, or a changed value never committed", () => {
    const a = entry();
    a.e.change("2026-12-03", false);
    a.e.close();
    expect(a.saved).toEqual(["2026-12-03"]);
    expect(a.clock.waiting()).toEqual([]);
    const b = entry();
    b.e.change("", false);
    b.e.close();
    expect(b.saved).toEqual([null]);
    const c = entry();
    c.e.close();
    expect(c.saved).toEqual([]);
  });

  it("an unmount never throws, even when the save does", () => {
    const clock = fakeSchedule();
    const e = new DateEntry(clock.schedule, createDirtyRegistry());
    e.sync("2026-12-01", asIs, () => {
      throw new Error("gone");
    });
    e.change("2026-12-03", false);
    expect(() => e.close()).not.toThrow();
  });

  it("is dirty while a save waits or a changed value is uncommitted", () => {
    const { e, clock, registry } = entry();
    e.change("2026-12-03", false);
    expect(registry.any()).toBe(true);
    clock.fire();
    expect(registry.any()).toBe(false);
    e.change("", false);
    expect(registry.any()).toBe(true);
    e.commit();
    expect(registry.any()).toBe(false);
  });
});
