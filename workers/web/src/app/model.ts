// The views' data, as plain functions over the mirror: the sidebar tree, the
// rows of a task list, Completed's grouping, and the pieces of the task
// detail. No React and no clock: "today" and the zone are passed in.
//
// Behaviour follows the Apple app (potem-apple: SyncKit Queries.swift,
// CompletedGrouping.swift, Recurrence.swift, ListName.swift) and
// docs/SYNC-API.md sections 4.2, 4.10 and 10.4.

import type { FeedTask, SmartList } from "../sync/feed.ts";

type FeedStep = FeedTask["steps"][number];
import { bodyText } from "../sync/plain-text.ts";
import { listTasks, smartListTasks } from "../sync/smart-lists.ts";
import type { MirrorList, MirrorStore } from "../sync/store.ts";

// ---------------------------------------------------------------- dates

const DAY_MS = 86_400_000;
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => dayOf(dayMs(day) + n * DAY_MS);

/** Formats a bare date with Intl, read as that calendar day (in UTC, so no zone shifts it). */
function formatDay(day: string, opts: Intl.DateTimeFormatOptions, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(new Date(dayMs(day)));
}

export type Tone = "overdue" | "today" | "future";

/** How a bare date reads in a row: Today, Tomorrow, Yesterday, or "Wed, May 20" (with the year outside this one). */
export function dateLabel(day: string, today: string, locale?: string): { text: string; tone: Tone } {
  const days = Math.round((dayMs(day) - dayMs(today)) / DAY_MS);
  const tone: Tone = days < 0 ? "overdue" : days === 0 ? "today" : "future";
  if (days === 0) return { text: "Today", tone };
  if (days === 1) return { text: "Tomorrow", tone };
  if (days === -1) return { text: "Yesterday", tone };
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (day.slice(0, 4) !== today.slice(0, 4)) opts.year = "numeric";
  return { text: formatDay(day, opts, locale), tone };
}

/** The date an instant falls on in `timeZone`, as YYYY-MM-DD. */
export function dayIn(instant: string, timeZone: string): string | null {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** A reminder's time, in the owner's zone: "Nov 26, 2026, 2:00 PM" in en-US. */
export function instantLabel(instant: string, timeZone: string, locale?: string): string | null {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(ms));
}

/** "Created today", "Created yesterday" or "Created on Mon, Jun 22". */
export function createdLabel(createdAt: string | null, today: string, timeZone: string, locale?: string): string | null {
  const day = createdAt === null ? null : dayIn(createdAt, timeZone);
  if (day === null) return null;
  const { text } = dateLabel(day, today, locale);
  return text === "Today" || text === "Yesterday" ? `Created ${text.toLowerCase()}` : `Created on ${text}`;
}

const MAX_WAIT_MS = 3_600_000;

/**
 * How long until the date changes in `timeZone`, plus a second. Never more
 * than an hour: a timer can fire late after the device sleeps, and the caller
 * re-checks the date each time it fires.
 */
export function msUntilNextDay(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(now);
  const part = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = ((part("hour") * 60 + part("minute")) * 60 + part("second")) * 1000 + now.getUTCMilliseconds();
  return Math.min(MAX_WAIT_MS, Math.max(1000, DAY_MS - elapsed + 1000));
}

// ---------------------------------------------------------------- order keys

// An order or sort key is an ISO instant in mixed forms (with and without
// fractional seconds; the server writes up to seven digits). Compared as
// instants (SYNC-API 10.4): whole seconds, then the fraction as 7 digits.
function instantKey(s: string): [number, number] | null {
  const dot = s.indexOf(".");
  const whole = dot === -1 ? s : `${s.slice(0, dot)}Z`;
  const ms = Date.parse(whole);
  if (Number.isNaN(ms)) return null;
  let frac = 0;
  if (dot !== -1) {
    const digits = /^\d*/.exec(s.slice(dot + 1))![0].slice(0, 7);
    frac = Number(digits.padEnd(7, "0"));
  }
  return [Math.floor(ms / 1000), frac];
}

/** Latest first; a missing or unreadable key last; 0 when tied. */
function byKeyDesc(a: string | null, b: string | null): number {
  const x = a === null ? null : instantKey(a);
  const y = b === null ? null : instantKey(b);
  if (x && y) return y[0] - x[0] || y[1] - x[1];
  if (x) return -1;
  if (y) return 1;
  return 0;
}

// ---------------------------------------------------------------- sidebar

/** To Do's theme colour names the app knows (potem-apple ThemeColor). Others show no theme. */
export const ACCENTS = [
  "dark_blue", "dark_purple", "dark_rose", "dark_red", "dark_green", "dark_teal", "dark_grey",
  "light_blue", "light_purple", "light_rose", "light_red", "light_green", "light_teal", "light_grey",
  "blue", "purple",
] as const;
export type Accent = (typeof ACCENTS)[number];
export const accentOf = (color: string | null | undefined): Accent | null =>
  (ACCENTS as readonly string[]).includes(color ?? "") ? (color as Accent) : null;

/** A list name as To Do shows it: a leading emoji becomes the icon. */
export function splitListName(name: string): { emoji: string | null; title: string } {
  const m = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*/u.exec(name);
  if (!m) return { emoji: null, title: name };
  const rest = name.slice(m[0].length);
  return rest === "" ? { emoji: null, title: name } : { emoji: m[1]!, title: rest };
}

export interface SidebarListItem {
  id: string;
  name: string;
  emoji: string | null;
  icon: "home" | "list";
  accent: Accent | null;
  /** Open tasks; null when hidden (reference lists). */
  count: number | null;
}
export type SidebarEntry =
  | { kind: "list"; list: SidebarListItem }
  | { kind: "group"; id: string; name: string; lists: SidebarListItem[] };
export interface SidebarTree {
  /** The default list, then groups and top-level lists in one ordering. */
  top: SidebarEntry[];
  /** Reference lists, in their own section, ungrouped. */
  reference: SidebarListItem[];
}

const isDefault = (l: MirrorList) => l.wellknown === "defaultList";
const nameCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const sidebarOrder = (a: { key: string | null; name: string }, b: { key: string | null; name: string }) =>
  byKeyDesc(a.key, b.key) || nameCompare(a.name, b.name);

export function sidebarTree(store: MirrorStore): SidebarTree {
  const open = new Map<string, number>();
  for (const t of store.tasks()) {
    if (t.status !== "completed" && t.list_id !== null) open.set(t.list_id, (open.get(t.list_id) ?? 0) + 1);
  }
  const item = (l: MirrorList): SidebarListItem => {
    const name = l.name ?? "Untitled list";
    const { emoji, title } = splitListName(name);
    return {
      id: l.id,
      name: title,
      emoji,
      icon: isDefault(l) ? "home" : "list",
      accent: accentOf(l.theme.color),
      count: l.sync === "reference" ? null : (open.get(l.id) ?? 0),
    };
  };
  const byOrder = (a: MirrorList, b: MirrorList) =>
    sidebarOrder({ key: a.sort_key, name: a.name ?? "" }, { key: b.sort_key, name: b.name ?? "" });

  const lists = [...store.lists()];
  const todo = lists.filter((l) => l.sync !== "reference");
  const groups = new Map(store.groups().map((g) => [g.id, g]));
  const groupOf = (l: MirrorList) => (l.group_id !== null && groups.has(l.group_id) ? l.group_id : null);

  const defaults = todo.filter((l) => isDefault(l) && groupOf(l) === null).sort(byOrder);
  const members = new Map<string, MirrorList[]>();
  const top: { key: string | null; name: string; entry: () => SidebarEntry }[] = [];
  for (const l of todo) {
    const g = groupOf(l);
    if (g !== null) members.set(g, [...(members.get(g) ?? []), l]);
    else if (!isDefault(l)) top.push({ key: l.sort_key, name: l.name ?? "", entry: () => ({ kind: "list", list: item(l) }) });
  }
  for (const g of groups.values()) {
    top.push({
      key: g.sort_key,
      name: g.name ?? "",
      entry: () => ({ kind: "group", id: g.id, name: g.name ?? "Untitled group", lists: (members.get(g.id) ?? []).sort(byOrder).map(item) }),
    });
  }
  top.sort(sidebarOrder);
  return {
    top: [...defaults.map((l): SidebarEntry => ({ kind: "list", list: item(l) })), ...top.map((t) => t.entry())],
    reference: lists.filter((l) => l.sync === "reference").sort(byOrder).map(item),
  };
}

// ---------------------------------------------------------------- task rows

export type CompletedBucket =
  | { kind: "day"; day: string }
  | { kind: "week"; start: string; end: string }
  | { kind: "month"; year: number; month: number };

/**
 * Completed's grouping (SYNC-API 4.10): a day each for the 14 days up to
 * today (and any later day), then six seven-day weeks counting back from the
 * day before those, then calendar months.
 */
export function completedBucket(day: string, today: string): CompletedBucket {
  const firstDay = addDays(today, -13);
  if (day >= firstDay) return { kind: "day", day };
  const back = Math.floor((dayMs(firstDay) - dayMs(day) - DAY_MS) / (7 * DAY_MS));
  if (back < 6) {
    const end = addDays(firstDay, -1 - 7 * back);
    return { kind: "week", start: addDays(end, -6), end };
  }
  return { kind: "month", year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) };
}

function bucketLabel(b: CompletedBucket, today: string, locale: string | undefined): string {
  switch (b.kind) {
    case "day":
      return dateLabel(b.day, today, locale).text;
    case "week": {
      const sameMonth = b.start.slice(0, 7) === b.end.slice(0, 7);
      const first = formatDay(b.start, { month: "short", day: "numeric" }, locale);
      const last = formatDay(b.end, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" }, locale);
      const year = b.end.slice(0, 4) === today.slice(0, 4) ? "" : `, ${b.end.slice(0, 4)}`;
      return `${first} – ${last}${year}`;
    }
    case "month":
      return formatDay(`${b.year}-${String(b.month).padStart(2, "0")}-01`, { month: "long", year: "numeric" }, locale);
  }
}

const bucketKey = (b: CompletedBucket) => (b.kind === "day" ? b.day : b.kind === "week" ? `w${b.start}` : `m${b.year}-${b.month}`);

export interface CompletedGroup {
  key: string;
  label: string;
  ids: string[];
}

/** The Completed smart list in groups, newest first; tasks with no completion date last. */
export function completedGroups(store: MirrorStore, today: string, locale?: string): CompletedGroup[] {
  const groups: CompletedGroup[] = [];
  // The list is sorted by completed_at desc with nulls last, so each group is one run.
  for (const t of smartListTasks(store, "completed", { today })) {
    const b = t.completed_at === null ? null : completedBucket(t.completed_at, today);
    const key = b === null ? "none" : bucketKey(b);
    const last = groups.at(-1);
    if (last?.key === key) last.ids.push(t.id);
    else groups.push({ key, label: b === null ? "No completion date" : bucketLabel(b, today, locale), ids: [t.id] });
  }
  return groups;
}

export type TaskView = { view: "smart"; list: SmartList } | { view: "list"; id: string };
export type TaskRow =
  | { kind: "task"; id: string }
  /** A heading in the list; `toggle` when it opens and closes the tasks under it. */
  | { kind: "section"; key: string; label: string; count: number; toggle: boolean };

/** The rows a task list shows: tasks, and the headings between them. */
export function taskRows(
  store: MirrorStore,
  view: TaskView,
  today: string,
  opts: { completedOpen: boolean },
  locale?: string,
): TaskRow[] {
  const rows: TaskRow[] = [];
  if (view.view === "smart" && view.list === "completed") {
    for (const g of completedGroups(store, today, locale)) {
      rows.push({ kind: "section", key: g.key, label: g.label, count: g.ids.length, toggle: false });
      for (const id of g.ids) rows.push({ kind: "task", id });
    }
    return rows;
  }
  const tasks = view.view === "smart" ? smartListTasks(store, view.list, { today }) : listTasks(store, view.id);
  const done: string[] = [];
  for (const t of tasks) {
    if (t.status === "completed") done.push(t.id);
    else rows.push({ kind: "task", id: t.id });
  }
  if (done.length > 0) {
    rows.push({ kind: "section", key: "completed", label: "Completed", count: done.length, toggle: true });
    if (opts.completedOpen) for (const id of done) rows.push({ kind: "task", id });
  }
  return rows;
}

// ---------------------------------------------------------------- detail

/** Steps as To Do shows them: ordered ones latest first, then the rest by creation. */
export function orderedSteps(steps: readonly FeedStep[]): FeedStep[] {
  return steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const x = a.s.created_at, y = b.s.created_at;
      const byCreated = x !== null && y !== null && x !== y ? (x < y ? -1 : 1) : 0;
      return byKeyDesc(a.s.order, b.s.order) || byCreated || a.i - b.i;
    })
    .map(({ s }) => s);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored recurrence (Graph's patternedRecurrence) in words: "Weekly", "Every 2 days", "Weekdays". */
export function describeRecurrence(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.pattern) || typeof value.pattern.type !== "string") return null;
  const p = value.pattern;
  const interval = typeof p.interval === "number" && p.interval >= 1 ? Math.floor(p.interval) : 1;
  const days = Array.isArray(p.daysOfWeek) ? p.daysOfWeek.filter((d): d is string => typeof d === "string") : [];
  const every = (one: string, many: string) => (interval === 1 ? one : `Every ${interval} ${many}`);
  switch (p.type) {
    case "daily":
      return every("Daily", "days");
    case "weekly": {
      const weekdays = WEEKDAYS.slice(1, 6);
      if (interval === 1 && days.length === 5 && weekdays.every((d) => days.includes(d))) return "Weekdays";
      const base = every("Weekly", "weeks");
      if (days.length <= 1) return base;
      const short = WEEKDAYS.filter((d) => days.includes(d)).map((d) => d[0]!.toUpperCase() + d.slice(1, 3));
      return `${base}: ${short.join(", ")}`;
    }
    case "absoluteMonthly":
    case "relativeMonthly":
      return every("Monthly", "months");
    case "absoluteYearly":
    case "relativeYearly":
      return every("Yearly", "years");
    default:
      return "Repeats";
  }
}

// Tags that end a line when an html body is read as text. A private-use
// character marks each one; bodyText keeps it (it isn't whitespace), and the
// text is split on it afterwards.
const LINE_BREAK_TAGS = new Set(["br", "/p", "/div", "/li", "/tr", "/h1", "/h2", "/h3", "/h4", "/h5", "/h6", "/blockquote", "/pre"]);
const MARK = "";

function markLineBreaks(html: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt === -1) return out + html.slice(i);
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) return out + html.slice(i);
    const name = /^\/?[a-zA-Z0-9]*/.exec(html.slice(lt + 1, Math.min(gt, lt + 13)))![0].toLowerCase();
    out += html.slice(i, gt + 1) + (LINE_BREAK_TAGS.has(name) ? MARK : "");
    i = gt + 1;
  }
}

/**
 * A task note as plain text with its line breaks: a text body as written; an
 * html body read by the same rule as search (bodyText, SYNC-API 4.10), with a
 * line break where a block or <br> ended. Never markup: the view renders it as
 * a text node.
 */
export function noteText(body: FeedTask["body"]): string {
  if (body === null) return "";
  if (body.type !== "html") return body.content;
  const text = bodyText({ type: "html", content: markLineBreaks(body.content.replaceAll(MARK, "")) });
  return text
    .split(MARK)
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** The URL to link to, or null unless it is an absolute http:, https: or mailto: URL. */
export function safeHref(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    return SAFE_PROTOCOLS.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

export type TextPart = { text: string; href?: string };

const URL_IN_TEXT = /\b(?:https?:\/\/|mailto:)[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]}]+$/;

/** Splits text into plain parts and links (only safe ones; others stay text). */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let plain = "";
  let last = 0;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const url = m[0].replace(TRAILING, "");
    const href = safeHref(url);
    if (href === null || url === "") continue;
    plain += text.slice(last, m.index);
    if (plain !== "") parts.push({ text: plain });
    plain = "";
    parts.push({ text: url, href });
    last = m.index + url.length;
  }
  plain += text.slice(last);
  if (plain !== "") parts.push({ text: plain });
  return parts;
}

/** Where the browser downloads an attachment (the BFF's read-only proxy). */
export const attachmentHref = (id: string) => `/bff/api/attachments/${encodeURIComponent(id)}`;

/** A file size as the Mac app shows it: "325 bytes", "48 KB", "2.4 MB". */
export function sizeLabel(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1000;
  let u = 0;
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000;
    u++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}
