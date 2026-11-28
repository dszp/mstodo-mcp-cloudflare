import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeedChange, FeedList, FeedListGroup, FeedTask } from "../sync/feed.ts";
import { MirrorStore } from "../sync/store.ts";
import {
  completedBucket,
  createdLabel,
  completedGroups,
  dateLabel,
  describeRecurrence,
  linkify,
  msUntilNextDay,
  noteText,
  olderTasks,
  parseSearchResponse,
  parseTaskResponse,
  orderedSteps,
  safeHref,
  searchPath,
  searchText,
  sidebarTree,
  taskRows,
} from "./model.ts";
import { LinkedText } from "./views/LinkedText.tsx";

const TODAY = "2026-11-27";

function taskData(over: Partial<FeedTask> = {}): FeedTask {
  return {
    list_id: "L1", title: "T", status: "notStarted", body: null, importance: null, categories: [],
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
let seq = 0;
const task = (id: string, over: Partial<FeedTask> = {}): FeedChange => ({
  kind: "task", id, seq: ++seq, deleted: false, data: taskData(over), field_clock: {},
});
const list = (id: string, over: Partial<FeedList> = {}): FeedChange => ({
  kind: "list", id, seq: ++seq, deleted: false, data: listData(over),
});
const group = (id: string, data: FeedListGroup): FeedChange => ({ kind: "list_group", id, seq: ++seq, deleted: false, data });
function storeOf(...changes: FeedChange[]): MirrorStore {
  const s = new MirrorStore();
  s.applyPage(changes);
  return s;
}

describe("sidebarTree", () => {
  const s = storeOf(
    group("G-old", { name: "Older group", sort_key: "2026-11-20T10:00:00Z" }),
    group("G-new", { name: "Newer group", sort_key: "2026-11-23T23:45:49.248Z" }),
    group("G-empty", { name: "Empty group", sort_key: "2026-11-01T00:00:00Z" }),
    list("DEF", { name: "Tasks", wellknown: "defaultList" }),
    // Mixed forms: with and without milliseconds, compared as instants.
    list("TOP-A", { name: "Top A", sort_key: "2026-11-23T23:45:47Z" }),
    list("TOP-B", { name: "Top B", sort_key: "2026-11-23T23:45:45.623Z" }),
    list("IN-1", { name: "In one", group_id: "G-new", sort_key: "2026-11-02T00:00:00Z", theme: { color: "dark_red", background: null } }),
    list("IN-2", { name: "🛒 In two", group_id: "G-new", sort_key: "2026-11-03T00:00:00Z", theme: { color: "beach", background: null } }),
    list("ORPHAN", { name: "Orphan", group_id: "G-missing", sort_key: "2026-01-01T00:00:00Z" }),
    list("REF", { name: "Archive", sync: "reference", sort_key: "2026-11-25T00:00:00Z" }),
    task("t1", { list_id: "IN-1" }),
    task("t2", { list_id: "IN-1" }),
    task("t3", { list_id: "IN-1", status: "completed", completed_at: TODAY }),
    task("t4", { list_id: "REF" }),
  );
  const tree = sidebarTree(s);

  it("puts the default list first, then groups and top-level lists by sort key, latest first", () => {
    expect(tree.top.map((e) => (e.kind === "group" ? `group:${e.id}` : e.list.id))).toEqual([
      "DEF",
      "group:G-new",
      "TOP-A",
      "TOP-B",
      "group:G-old",
      "group:G-empty",
      "ORPHAN",
    ]);
  });

  it("puts a list in its group, ordered within it", () => {
    const g = tree.top.find((e) => e.kind === "group" && e.id === "G-new");
    expect(g?.kind === "group" && g.lists.map((l) => l.id)).toEqual(["IN-2", "IN-1"]);
    const empty = tree.top.find((e) => e.kind === "group" && e.id === "G-empty");
    expect(empty?.kind === "group" && empty.lists).toEqual([]);
  });

  it("counts open tasks, and shows a list's theme colour only when the app knows it", () => {
    const g = tree.top.find((e) => e.kind === "group" && e.id === "G-new");
    const [two, one] = g?.kind === "group" ? g.lists : [];
    expect(one).toMatchObject({ count: 2, accent: "dark_red", emoji: null, name: "In one" });
    expect(two).toMatchObject({ count: 0, accent: null, emoji: "🛒", name: "In two" });
    expect(tree.top[0]).toMatchObject({ kind: "list", list: { id: "DEF", icon: "home" } });
  });

  it("lists reference lists separately and hides their count", () => {
    expect(tree.reference.map((l) => l.id)).toEqual(["REF"]);
    expect(tree.reference[0]!.count).toBeNull();
  });
});

describe("completed grouping", () => {
  // 14 days up to today: Nov 14 .. Nov 27. Then six weeks: Nov 7-13, Oct 31-Nov 6,
  // Oct 24-30, Oct 17-23, Oct 10-16, Oct 3-9. Before Oct 3: months.
  it.each([
    ["2026-11-28", { kind: "day", day: "2026-11-28" }],
    [TODAY, { kind: "day", day: TODAY }],
    ["2026-11-14", { kind: "day", day: "2026-11-14" }],
    ["2026-11-13", { kind: "week", start: "2026-11-07", end: "2026-11-13" }],
    ["2026-11-07", { kind: "week", start: "2026-11-07", end: "2026-11-13" }],
    ["2026-11-06", { kind: "week", start: "2026-10-31", end: "2026-11-06" }],
    ["2026-10-03", { kind: "week", start: "2026-10-03", end: "2026-10-09" }],
    ["2026-10-02", { kind: "month", year: 2026, month: 10 }],
    ["2025-12-31", { kind: "month", year: 2025, month: 12 }],
  ])("puts %s in %o", (day, bucket) => {
    expect(completedBucket(day, TODAY)).toEqual(bucket);
  });

  it("groups tasks in their order, labels each group, and puts tasks with no date last", () => {
    const s = storeOf(
      list("L1"),
      task("a", { status: "completed", completed_at: TODAY }),
      task("b", { status: "completed", completed_at: "2026-11-26" }),
      task("c", { status: "completed", completed_at: "2026-11-24" }),
      task("d", { status: "completed", completed_at: "2026-11-10" }),
      task("e", { status: "completed", completed_at: "2026-11-08" }),
      task("f", { status: "completed", completed_at: "2026-11-02" }),
      task("g", { status: "completed", completed_at: "2026-05-19" }),
      task("h", { status: "completed", completed_at: null }),
    );
    const groups = completedGroups(s, TODAY, "en-US");
    expect(groups.map((g) => [g.label, g.ids])).toEqual([
      ["Today", ["a"]],
      ["Yesterday", ["b"]],
      ["Tue, Nov 24", ["c"]],
      ["Nov 7 – 13", ["d", "e"]],
      ["Oct 31 – Nov 6", ["f"]],
      ["May 2026", ["g"]],
      ["No completion date", ["h"]],
    ]);
  });

  it("adds the year to a week outside this year", () => {
    const s = storeOf(list("L1"), task("a", { status: "completed", completed_at: "2025-12-30" }));
    expect(completedGroups(s, "2026-01-20", "en-US").map((g) => g.label)).toEqual(["Dec 24 – 30, 2025"]);
  });
});

describe("task rows", () => {
  const s = storeOf(
    list("L1"),
    task("open1", { order: "2" }),
    task("open2", { order: "1" }),
    task("done1", { status: "completed", completed_at: TODAY }),
  );
  it("puts a list's completed tasks in a Completed section, shown only when open", () => {
    expect(taskRows(s, { view: "list", id: "L1" }, TODAY, { completedOpen: false }, "en-US")).toEqual([
      { kind: "task", id: "open1" },
      { kind: "task", id: "open2" },
      { kind: "section", key: "completed", label: "Completed", count: 1, toggle: true },
    ]);
    expect(taskRows(s, { view: "list", id: "L1" }, TODAY, { completedOpen: true }, "en-US").at(-1)).toEqual({ kind: "task", id: "done1" });
  });
});

describe("dateLabel", () => {
  it.each([
    [TODAY, { text: "Today", tone: "today" }],
    ["2026-11-28", { text: "Tomorrow", tone: "future" }],
    ["2026-11-26", { text: "Yesterday", tone: "overdue" }],
    ["2026-05-20", { text: "Wed, May 20", tone: "overdue" }],
    ["2027-01-05", { text: "Tue, Jan 5, 2027", tone: "future" }],
  ])("labels %s", (day, label) => {
    expect(dateLabel(day, TODAY, "en-US")).toEqual(label);
  });
});

describe("links", () => {
  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", " java\nscript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd", "/relative", "not a url", ""])(
    "drops %j",
    (url) => {
      expect(safeHref(url)).toBeNull();
    },
  );
  it.each([
    ["https://example.com/a?b=c", "https://example.com/a?b=c"],
    ["http://example.com", "http://example.com/"],
    ["mailto:someone@example.com", "mailto:someone@example.com"],
  ])("keeps %s", (url, href) => {
    expect(safeHref(url)).toBe(href);
  });

  it("finds http, https and mailto links in text and leaves the rest as text", () => {
    expect(linkify("See https://example.com/x. Or mailto:a@example.com, not javascript:alert(1)")).toEqual([
      { text: "See " },
      { text: "https://example.com/x", href: "https://example.com/x" },
      { text: ". Or " },
      { text: "mailto:a@example.com", href: "mailto:a@example.com" },
      { text: ", not javascript:alert(1)" },
    ]);
  });
});

describe("linkify on hostile input", () => {
  const timed = (text: string) => {
    const start = performance.now();
    const parts = linkify(text);
    return { parts, ms: performance.now() - start };
  };

  it("trims a long punctuation run in linear time", () => {
    const dots = ".".repeat(50_000);
    for (const text of [`https://example.com/${dots}`, `https://example.com/${dots}x`, `see https://example.com/${dots} more`, ".".repeat(100_000)]) {
      const { parts, ms } = timed(text);
      expect(ms, text.slice(-12)).toBeLessThan(50);
      expect(parts.map((p) => p.text).join("")).toBe(text);
    }
  });

  it("caps one link's length", () => {
    const long = `https://example.com/${"a".repeat(5000)}`;
    const links = linkify(long).filter((p) => p.href !== undefined);
    // 2048 characters after the scheme.
    expect(links[0]!.text.length).toBe("https://".length + 2048);
  });

  it.each([
    ["(see https://example.com/a).", "https://example.com/a"],
    ["https://example.com/a?b=c!?", "https://example.com/a?b=c"],
    ["mailto:a@example.com;", "mailto:a@example.com"],
    ["https://example.com/a]}", "https://example.com/a"],
  ])("drops trailing punctuation from %s", (text, url) => {
    expect(linkify(text).find((p) => p.href !== undefined)?.text).toBe(url);
  });
});

describe("note text", () => {
  it("keeps a text body as written", () => {
    expect(noteText({ type: "text", content: "one\n\ntwo <b>x</b>" })).toBe("one\n\ntwo <b>x</b>");
  });

  it("turns an html body into lines of text", () => {
    expect(noteText({ type: "html", content: "<div>first&nbsp;line</div><div>second<br>third</div><p></p><p>fourth</p>" })).toBe(
      "first line\nsecond\nthird\n\nfourth",
    );
  });

  it("yields no element from a hostile body", () => {
    const text = noteText({ type: "html", content: '<img src=x onerror=alert(1)>hi<script>alert(2)</script><a href="javascript:alert(3)">link</a>' });
    expect(text).toBe("hi link");
    // A text body keeps markup as characters; rendering escapes it.
    const raw = noteText({ type: "text", content: "<img src=x onerror=alert(1)> javascript:alert(1)" });
    const html = renderToStaticMarkup(createElement(LinkedText, { text: raw }));
    expect(html).not.toMatch(/<img|<a\b/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders only safe links, opening in a new tab without a referrer", () => {
    const html = renderToStaticMarkup(createElement(LinkedText, { text: "go https://example.com/" }));
    expect(html).toBe('go <a href="https://example.com/" target="_blank" rel="noopener noreferrer">https://example.com/</a>');
  });
});

describe("detail helpers", () => {
  it("orders steps: ordered ones latest first, then the rest by creation", () => {
    const steps = [
      { id: "s1", title: "a", checked: false, checked_at: null, created_at: "2026-11-01T00:00:00Z", order: null },
      { id: "s2", title: "b", checked: false, checked_at: null, created_at: "2026-10-01T00:00:00Z", order: null },
      { id: "s3", title: "c", checked: true, checked_at: null, created_at: "2026-12-01T00:00:00Z", order: "2026-11-20T00:00:00Z" },
      { id: "s4", title: "d", checked: false, checked_at: null, created_at: "2026-12-01T00:00:00Z", order: "2026-11-21T00:00:00.5Z" },
    ];
    expect(orderedSteps(steps).map((x) => x.id)).toEqual(["s4", "s3", "s2", "s1"]);
  });

  it.each([
    [{ pattern: { type: "daily", interval: 1 } }, "Daily"],
    [{ pattern: { type: "daily", interval: 3 } }, "Every 3 days"],
    [{ pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"] } }, "Weekdays"],
    [{ pattern: { type: "weekly", interval: 1, daysOfWeek: ["friday", "monday"] } }, "Weekly: Mon, Fri"],
    [{ pattern: { type: "absoluteMonthly", interval: 1 } }, "Monthly"],
    [{ pattern: { type: "relativeYearly", interval: 2 } }, "Every 2 years"],
    [{ pattern: { type: "odd" } }, "Repeats"],
    [null, null],
    ["nonsense", null],
  ])("describes %j as %j", (r, text) => {
    expect(describeRecurrence(r)).toBe(text);
  });
});

describe("createdLabel", () => {
  const zone = "America/New_York";
  it.each([
    ["2026-11-27T15:00:00Z", "Created today"],
    ["2026-11-26T15:00:00Z", "Created yesterday"],
    ["2026-06-22T15:00:00Z", "Created on Mon, Jun 22"],
    // A clock ahead of the server's: a date, never "Created on Tomorrow".
    ["2026-11-28T15:00:00Z", "Created on Sat, Nov 28"],
    ["2027-01-05T15:00:00Z", "Created on Tue, Jan 5, 2027"],
  ])("labels %s", (at, label) => {
    expect(createdLabel(at, TODAY, zone, "en-US")).toBe(label);
  });
});

describe("msUntilNextDay", () => {
  it("counts to the next midnight in the zone", () => {
    // 23:30 in New York (UTC-5 in November).
    const now = new Date("2026-11-28T04:30:00Z");
    const ms = msUntilNextDay("America/New_York", now);
    expect(ms).toBeGreaterThanOrEqual(30 * 60_000);
    expect(ms).toBeLessThan(30 * 60_000 + 2_000);
  });
  it("waits at most an hour, so a sleeping device catches up", () => {
    expect(msUntilNextDay("UTC", new Date("2026-11-27T01:00:00Z"))).toBe(3_600_000);
  });
});

describe("searchText / searchPath", () => {
  it("trims the query; blank is empty", () => {
    expect(searchText("  milk \t")).toBe("milk");
    expect(searchText("   ")).toBe("");
    expect(searchText("")).toBe("");
  });

  it("builds the server path from the trimmed, encoded query", () => {
    expect(searchPath("  milk & eggs ")).toBe("search?q=milk%20%26%20eggs");
    expect(searchPath("café")).toBe("search?q=caf%C3%A9");
  });

  it("has no path for an empty query", () => {
    expect(searchPath("")).toBeNull();
    expect(searchPath(" \n ")).toBeNull();
  });

  it("cuts a query at the server's 256-character limit", () => {
    const path = searchPath("a".repeat(300))!;
    expect(decodeURIComponent(path.slice("search?q=".length))).toBe("a".repeat(256));
  });

  it("never splits a character made of two UTF-16 units at the limit", () => {
    // 255 units, then an emoji (2 units) that would straddle the 256th.
    const path = searchPath(`${"a".repeat(255)}😀😀`)!;
    expect(decodeURIComponent(path.slice("search?q=".length))).toBe("a".repeat(255));
    // Whole emoji up to the limit are kept: 128 of them are 256 units.
    const emoji = searchPath("😀".repeat(200))!;
    expect(decodeURIComponent(emoji.slice("search?q=".length))).toBe("😀".repeat(128));
  });
});

describe("parseSearchResponse / parseTaskResponse", () => {
  const entry = (id: string, over: Partial<FeedTask> = {}) => ({ kind: "task", id, data: taskData({ title: id, ...over }), field_clock: {} });

  it("reads the results as tasks with their ids", () => {
    const hits = parseSearchResponse({ results: [entry("a"), entry("b")] })!;
    expect(hits.map((t) => [t.id, t.title])).toEqual([["a", "a"], ["b", "b"]]);
  });

  it("drops entries that aren't tasks the page can render", () => {
    const hits = parseSearchResponse({
      results: [
        entry("ok"),
        { kind: "task", id: "no-data" },
        { kind: "task", id: "bad id!", data: taskData() },
        { kind: "task", id: "no-steps", data: { ...taskData(), steps: null } },
        { kind: "task", id: "no-title", data: { ...taskData(), title: 4 } },
        null,
        "x",
      ],
    })!;
    expect(hits.map((t) => t.id)).toEqual(["ok"]);
  });

  it("is null when the response isn't a results list", () => {
    expect(parseSearchResponse(null)).toBeNull();
    expect(parseSearchResponse({})).toBeNull();
    expect(parseSearchResponse({ results: "x" })).toBeNull();
  });

  it("reads one task, or null", () => {
    expect(parseTaskResponse(entry("a"))?.id).toBe("a");
    expect(parseTaskResponse({ kind: "task", id: "a" })).toBeNull();
    expect(parseTaskResponse([])).toBeNull();
  });
});

describe("olderTasks", () => {
  const s = storeOf(task("mirror-open"), task("mirror-done", { status: "completed", completed_at: TODAY }));
  const hit = (id: string, over: Partial<FeedTask> = {}) => ({ ...taskData(over), id });

  it("drops hits the mirror already holds", () => {
    const hits = [hit("mirror-open"), hit("old-1"), hit("mirror-done"), hit("old-2")];
    expect(olderTasks(hits, [], s, true).map((t) => t.id)).toEqual(["old-1", "old-2"]);
  });

  it("drops hits already in the local results", () => {
    // A local result is always in the store; this also covers a result the store lost between renders.
    const hits = [hit("old-1"), hit("old-2")];
    expect(olderTasks(hits, ["old-1"], s, true).map((t) => t.id)).toEqual(["old-2"]);
  });

  it("drops a hit that repeats within the response", () => {
    expect(olderTasks([hit("old-1"), hit("old-1")], [], s, true)).toHaveLength(1);
  });

  it("leaves out completed hits when completed tasks are off", () => {
    const hits = [hit("old-open"), hit("old-done", { status: "completed", completed_at: "2026-01-02" })];
    expect(olderTasks(hits, [], s, false).map((t) => t.id)).toEqual(["old-open"]);
    expect(olderTasks(hits, [], s, true).map((t) => t.id)).toEqual(["old-open", "old-done"]);
  });

  it("keeps the server's order", () => {
    expect(olderTasks([hit("z"), hit("a"), hit("m")], [], s, true).map((t) => t.id)).toEqual(["z", "a", "m"]);
  });
});
