import { describe, expect, it } from "vitest";
import { generateFeed, pageOf } from "./fixture";
import type { FeedChange } from "../src/sync/feed";

const SIZES = [
  { totalTasks: 545, openTasks: 400, lists: 12 },
  { totalTasks: 2400, openTasks: 1100, lists: 25 },
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
        if (page.changes.length > 1) expect(new TextEncoder().encode(JSON.stringify(page.changes)).length).toBeLessThanOrEqual(1_000_000);
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
