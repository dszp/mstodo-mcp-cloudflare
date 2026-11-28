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
  moveTargets,
  msUntilNextDay,
  noticeText,
  reminderFromInput,
  reminderInputValue,
  noteText,
  olderTasks,
  searchDetailSource,
  parseSearchResponse,
  parseTaskResponse,
  orderedSteps,
  safeHref,
  searchPath,
  searchText,
  sidebarTree,
  taskRows,
  unsavedEditsText,
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

  it("replaces a lone surrogate instead of throwing", () => {
    const path = searchPath("\uD800abc")!;
    expect(decodeURIComponent(path.slice("search?q=".length))).toBe("\uFFFDabc");
    expect(searchPath("ab\uDC00")).toBe("search?q=ab%EF%BF%BD");
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

  it("doesn't bring back a mirror task that is pending deletion", () => {
    const p = storeOf(task("mirror-open"));
    p.setPending([{ id: "m1", at: "2026-11-27T12:00:00.000Z", op: "task.delete", sid: "mirror-open" }], {
      today: TODAY, defaultListId: "L1",
    });
    expect(olderTasks([hit("mirror-open"), hit("old-1")], [], p, true).map((t) => t.id)).toEqual(["old-1"]);
  });
});

describe("searchDetailSource", () => {
  const CTX = { today: TODAY, defaultListId: "L1" };
  const at = "2026-11-27T12:00:00.000Z";

  it("is the store for a mirror task and for a pending create", () => {
    const s = storeOf(task("a"));
    s.setPending([{ id: "m1", at, op: "task.create", sid: "n1", fields: { title: "New" } }], CTX);
    expect(searchDetailSource(s, "a")).toBe("store");
    expect(searchDetailSource(s, "n1")).toBe("store");
  });

  it("is gone for a mirror task pending deletion, never the server", () => {
    const s = storeOf(task("a"));
    s.setPending([{ id: "m1", at, op: "task.delete", sid: "a" }], CTX);
    expect(searchDetailSource(s, "a")).toBe("gone");
  });

  it("is the server for a task the mirror doesn't hold", () => {
    expect(searchDetailSource(storeOf(), "x")).toBe("server");
  });
});

describe("reminder input", () => {
  const NY = "America/New_York";

  it("shows an instant as the zone's wall time, to the minute", () => {
    expect(reminderInputValue("2026-11-26T19:00:00Z", NY)).toBe("2026-11-26T14:00");
    expect(reminderInputValue("2026-07-01T03:30:45.123Z", NY)).toBe("2026-06-30T23:30");
    expect(reminderInputValue("2026-11-26T19:00:00Z", "UTC")).toBe("2026-11-26T19:00");
  });

  it("shows nothing for an unreadable instant", () => {
    expect(reminderInputValue("soon", NY)).toBe("");
  });

  it("reads the zone's wall time back as a UTC instant", () => {
    expect(reminderFromInput("2026-11-26T14:00", NY)).toBe("2026-11-26T19:00:00Z");
    expect(reminderFromInput("2026-06-30T23:30", NY)).toBe("2026-07-01T03:30:00Z");
    expect(reminderFromInput("2026-11-26T14:00", "Asia/Kolkata")).toBe("2026-11-26T08:30:00Z");
  });

  it("round-trips across a year of days, both sides of each DST change", () => {
    for (let d = 0; d < 365; d++) {
      const day = new Date(Date.UTC(2026, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);
      const value = `${day}T12:15`;
      expect(reminderInputValue(reminderFromInput(value, NY)!, NY), value).toBe(value);
    }
  });

  it("moves a time the spring-forward gap skips to the same time after it", () => {
    // 2026-03-08 02:30 doesn't exist in New York; browsers read it as 03:30 EDT.
    expect(reminderFromInput("2026-03-08T02:30", NY)).toBe("2026-03-08T07:30:00Z");
    expect(reminderFromInput("2026-03-08T01:59", NY)).toBe("2026-03-08T06:59:00Z");
    expect(reminderFromInput("2026-03-08T03:00", NY)).toBe("2026-03-08T07:00:00Z");
  });

  it("reads a time the fall-back hour repeats as its first occurrence", () => {
    // 2026-11-01 01:30 happens twice in New York: EDT (05:30Z), then EST (06:30Z).
    expect(reminderFromInput("2026-11-01T01:30", NY)).toBe("2026-11-01T05:30:00Z");
    expect(reminderFromInput("2026-11-01T02:00", NY)).toBe("2026-11-01T07:00:00Z");
  });

  it("is null for an empty or malformed value", () => {
    expect(reminderFromInput("", NY)).toBeNull();
    expect(reminderFromInput("2026-11-26", NY)).toBeNull();
    expect(reminderFromInput("2026-13-01T10:00", NY)).toBeNull();
  });
});

describe("noticeText", () => {
  it("names the action and the reason for each rejected error", () => {
    expect(noticeText("task.update", "deleted")).toBe("Couldn't save: the task was deleted elsewhere.");
    expect(noticeText("step.update", "deleted")).toBe("Couldn't save the step: it was deleted elsewhere.");
    expect(noticeText("task.move", "list_excluded")).toBe("Couldn't move the task: that list doesn't sync.");
    expect(noticeText("task.create", "ambiguous_create")).toBe(
      "Couldn't confirm the new task: it may have been added twice. Check the list.",
    );
    expect(noticeText("task.delete", "too_large")).toBe("Couldn't delete the task: the edit is too large to send.");
  });

  it("reads an unknown or refused error as the server refusing it", () => {
    expect(noticeText("myday.add", "refused")).toBe("Couldn't add the task to My Day: the server refused it.");
    expect(noticeText("task.update", "invalid_field:title")).toBe("Couldn't save: the server refused it.");
    expect(noticeText("step.create", "graph_403")).toBe("Couldn't add the step: the server refused it.");
    expect(noticeText("list.create", "something_new")).toBe("Couldn't save: the server refused it.");
  });
});

describe("moveTargets", () => {
  const s = storeOf(
    group("G1", { name: "Group one", sort_key: "2026-11-23T00:00:00Z" }),
    group("G-empty", { name: "Empty", sort_key: "2026-11-22T00:00:00Z" }),
    list("DEF", { name: "Tasks", wellknown: "defaultList" }),
    list("TOP", { name: "Top", sort_key: "2026-11-24T00:00:00Z" }),
    list("IN-1", { name: "🛒 Shopping", group_id: "G1", sort_key: "2026-11-02T00:00:00Z" }),
    list("IN-2", { name: "Errands", group_id: "G1", sort_key: "2026-11-01T00:00:00Z" }),
    list("REF", { name: "Archive", sync: "reference" }),
  );

  it("offers every non-reference list but the task's own, grouped as in the sidebar", () => {
    expect(moveTargets(sidebarTree(s), "TOP")).toEqual([
      { kind: "list", id: "DEF", label: "Tasks" },
      { kind: "group", id: "G1", label: "Group one", lists: [{ id: "IN-1", label: "🛒 Shopping" }, { id: "IN-2", label: "Errands" }] },
    ]);
  });

  it("leaves out a group whose only list is the task's own", () => {
    const only = storeOf(group("G", { name: "G", sort_key: null }), list("A", { name: "A", group_id: "G" }), list("B", { name: "B" }));
    expect(moveTargets(sidebarTree(only), "A")).toEqual([{ kind: "list", id: "B", label: "B" }]);
  });
});

describe("unsavedEditsText", () => {
  it("counts the edits sign-out dropped, singular for one", () => {
    expect(unsavedEditsText(1)).toBe("1 edit wasn't saved.");
    expect(unsavedEditsText(3)).toBe("3 edits weren't saved.");
  });

  it("is null when nothing was dropped", () => {
    expect(unsavedEditsText(0)).toBeNull();
    expect(unsavedEditsText(null)).toBeNull();
  });
});
