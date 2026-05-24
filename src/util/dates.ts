// Phase 5 — date input parsing for query tools.
//
// Accepts either an absolute ISO date/datetime ("2026-06-01",
// "2026-06-01T12:00:00Z") or a relative offset against the current time
// ("+7d", "-30d", "+12h", "-2w"). Returns epoch ms, or null if unparseable so
// callers can reject with a clear `invalid_date` instead of silently widening a
// filter. Units: d=days, h=hours, w=weeks, m=minutes.

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseDateInput(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;

  const rel = trimmed.match(/^([+-])(\d+)([mhdw])$/);
  if (rel) {
    const sign = rel[1] === "-" ? -1 : 1;
    const amount = Number(rel[2]);
    const unit = UNIT_MS[rel[3]];
    return Date.now() + sign * amount * unit;
  }

  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}
