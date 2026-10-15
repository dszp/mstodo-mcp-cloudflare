// Date input handling for tool arguments.
//
// The model names dates the way a person does — "2026-10-20", "2026-10-20T09:00"
// — meaning the owner's local time, not UTC. Those naive forms are read in the
// configured TIMEZONE (an IANA name); a value with an explicit `Z` or `±hh:mm`
// offset is taken as written. Graph wants UTC, and the To Do app stores a
// due date as local midnight in UTC (2026-10-20 in New York → 04:00Z), so
// converting here makes tool-set dates land on the same day the app shows.

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

// Offset of `timeZone` from UTC at instant `utcMs`, in ms (EDT → -4 h).
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// The UTC instant at which the wall clock in `timeZone` reads `wall`
// (YYYY-MM-DDTHH:MM[:SS[.fff]]). Two passes settle the offset across a DST
// transition; a wall time inside a spring-forward gap resolves to the later
// offset, which is what calendar apps do.
export function zonedWallTimeToUtc(wall: string, timeZone: string): number | null {
  const m = NAIVE_DATETIME.exec(wall);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    return null;
  }
  const first = asUtc - zoneOffsetMs(asUtc, timeZone);
  return asUtc - zoneOffsetMs(first, timeZone);
}

// Absolute instant for a date/datetime string, or null if unparseable.
// `bound` matters only for a date-only value: "start" is local midnight,
// "end" is the last millisecond of that local day, so an on/before filter
// includes the whole named day.
function absoluteMs(s: string, timeZone: string, bound: "start" | "end"): number | null {
  if (HAS_OFFSET.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  const dateOnly = DATE_ONLY.exec(s);
  if (dateOnly) {
    const start = zonedWallTimeToUtc(`${s}T00:00:00`, timeZone);
    if (start === null || bound === "start") return start;
    const next = new Date(Date.UTC(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3] + 1));
    const nextStart = zonedWallTimeToUtc(`${next.toISOString().slice(0, 10)}T00:00:00`, timeZone);
    return nextStart === null ? null : nextStart - 1;
  }
  return zonedWallTimeToUtc(s, timeZone);
}

// Query-filter input: an absolute date/datetime or a relative offset against
// now ("+7d", "-30d", "+12h", "-2w"; units m/h/d/w). Returns epoch ms, or null
// so callers can reject with `invalid_date` instead of silently widening a
// filter.
export function parseDateInput(
  s: string,
  timeZone = "UTC",
  bound: "start" | "end" = "start",
): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;

  const rel = trimmed.match(/^([+-])(\d+)([mhdw])$/);
  if (rel) {
    const sign = rel[1] === "-" ? -1 : 1;
    return Date.now() + sign * Number(rel[2]) * UNIT_MS[rel[3]];
  }
  return absoluteMs(trimmed, timeZone, bound);
}

// Graph dateTimeTimeZone for a write (due, reminder, start, completed). Always
// sent as UTC so Graph never has to resolve a zone name.
export function toGraphDateTime(
  s: string,
  timeZone: string,
): { dateTime: string; timeZone: "UTC" } | null {
  const ms = absoluteMs(s.trim(), timeZone, "start");
  if (ms === null) return null;
  return { dateTime: new Date(ms).toISOString().replace(/Z$/, ""), timeZone: "UTC" };
}
