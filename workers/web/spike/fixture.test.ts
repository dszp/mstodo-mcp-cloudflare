import { describe, expect, it } from "vitest";
import { generateFeed, pageOf } from "./fixture";
import type { FeedChange } from "../src/sync/feed";

const SIZES = [
  { totalTasks: 2400, openTasks: 545, lists: 12 },
  { totalTasks: 13000, openTasks: 545, lists: 25 },
  { totalTasks: 13000, openTasks: 3000, lists: 40 },
];

describe("generateFeed", () => {
  it("is deterministic for a seed", () => {
    const o = { totalTasks: 300, openTasks: 120, lists: 10, seed: 7 };
    expect(JSON.stringify(generateFeed(o))).toBe(JSON.stringify(generateFeed(o)));
    expect(JSON.stringify(generateFeed(o))).not.toBe(JSON.stringify(generateFeed({ ...o, seed: 8 })));
  });

  for (const s of SIZES) {
    it(`produces the requested open and total counts (${s.totalTasks})`, () => {
      const feed = generateFeed({ ...s, seed: 1 });
      const tasks = feed.filter((c) => c.kind === "task");
      expect(tasks).toHaveLength(s.totalTasks);
      expect(tasks.filter((c) => c.kind === "task" && !c.deleted && c.data.status !== "completed")).toHaveLength(s.openTasks);
      expect(feed.filter((c) => c.kind === "list")).toHaveLength(s.lists);
      expect(feed.filter((c) => c.kind === "list_group")).toHaveLength(Math.ceil(s.lists / 8));
      const seqs = feed.map((c) => c.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(feed.map((c) => c.id)).size).toBe(feed.length);
    });
  }

  for (const s of SIZES) {
    it(`has recently completed tasks and sane dates (${s.openTasks}/${s.totalTasks})`, () => {
      const tasks = generateFeed({ ...s, seed: 1 }).flatMap((c) => (c.kind === "task" && !c.deleted ? [c.data] : []));
      const recent = tasks.filter((t) => t.status === "completed" && t.completed_at! >= "2026-10-28");
      expect(recent.length).toBeGreaterThanOrEqual(1);
      for (const t of tasks) {
        expect(t.modified_at! <= "2026-11-27T23:59:59.999Z").toBe(true);
        expect(t.created_at! <= t.modified_at!).toBe(true);
        if (t.completed_at) expect(t.created_at!.slice(0, 10) <= t.completed_at).toBe(true);
      }
    });
  }

  it("sets realistic fields", () => {
    const feed = generateFeed({ totalTasks: 2000, openTasks: 1000, lists: 20, seed: 3 });
    const lists = feed.flatMap((c) => (c.kind === "list" && !c.deleted ? [c.data] : []));
    expect(lists.some((l) => l.sync === "reference")).toBe(true);
    expect(lists.some((l) => l.group_id === null)).toBe(true);
    const tasks = feed.flatMap((c) => (c.kind === "task" && !c.deleted ? [c.data] : []));
    const myDay = tasks.filter((t) => t.my_day.committed_day === "2026-11-27");
    expect(myDay.length).toBeGreaterThan(0);
    expect(myDay.every((t) => t.my_day.committed_order !== null)).toBe(true);
    expect(tasks.filter((t) => t.status === "completed").every((t) => t.completed_at !== null)).toBe(true);
    expect(tasks.some((t) => t.steps.length > 0 && t.steps[0].id && t.steps[0].title)).toBe(true);
  });
});

describe("pageOf", () => {
  it("cuts a page at 1 MB before the limit, keeping the whole page under budget", () => {
    const all = generateFeed({ totalTasks: 13000, openTasks: 3000, lists: 40, seed: 5 });
    const ids: string[] = [];
    let cut = false;
    let cursor: string | null = null;
    for (;;) {
      const page = pageOf(all, cursor, 5000);
      expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(1_000_000);
      if (page.has_more && page.changes.length < 5000) cut = true;
      ids.push(...page.changes.map((c) => c.id));
      if (!page.has_more) break;
      cursor = page.cursor;
    }
    expect(cut).toBe(true);
    expect(ids).toEqual(all.map((c) => c.id));
  });

  for (const s of SIZES) {
    it(`pages never exceed limit or 1 MB and cover every change exactly once (${s.totalTasks})`, () => {
      const all = generateFeed({ ...s, seed: 5 });
      const seen: FeedChange[] = [];
      let cursor: string | null = null;
      let guard = 0;
      for (;;) {
        const page = pageOf(all, cursor, 500);
        expect(page.changes.length).toBeLessThanOrEqual(500);
        expect(page.changes.length).toBeGreaterThan(0);
        if (page.changes.length > 1) expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(1_000_000);
        expect(page.backfill).toEqual({ remaining: 0 });
        seen.push(...page.changes);
        if (!page.has_more) {
          expect(pageOf(all, page.cursor, 500).changes).toHaveLength(0);
          break;
        }
        cursor = page.cursor;
        if (++guard > 1000) throw new Error("did not terminate");
      }
      expect(seen.map((c) => c.id)).toEqual(all.map((c) => c.id));
    });
  }
});
