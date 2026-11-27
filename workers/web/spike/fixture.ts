// Seeded synthetic change feed for the performance spike. Imitates the shapes
// of GET /api/v1/sync/changes (docs/SYNC-API.md 4.1-4.2); all text is
// lorem-style filler, never real data. Never reads the clock.
import type { FeedChange, FeedPage, FeedTask, FeedList } from "../src/sync/feed";

export interface FixtureOpts {
  totalTasks: number;
  openTasks: number;
  lists: number;
  seed: number;
  stepsPerTaskMax?: number; // default 4
  bodyCharsMax?: number; // default 600
  today?: string; // YYYY-MM-DD, default "2026-11-27"
}

const PAGE_BYTE_BUDGET = 1_000_000;

const WORDS = (
  "alpha bravo cinder delta ember fjord garnet harbor indigo juniper kestrel lantern meadow nectar orchid " +
  "pebble quartz ripple saffron timber umber velvet willow xenon yarrow zephyr amber basil cobalt dune " +
  "elm flint grove heron iris jasper kelp lumen moss nova opal pine quill reed sage thistle"
).split(" ");

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86_400_000;

export function generateFeed(opts: FixtureOpts): FeedChange[] {
  const rnd = mulberry32(opts.seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const chance = (p: number) => rnd() < p;
  const stepsMax = opts.stepsPerTaskMax ?? 4;
  const bodyMax = opts.bodyCharsMax ?? 600;
  const today = opts.today ?? "2026-11-27";
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const day = (offset: number) => new Date(todayMs + offset * DAY_MS).toISOString().slice(0, 10);

  const hex = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += int(16).toString(16);
    return s;
  };
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + int(4)).toString(16)}${hex(3)}-${hex(12)}`;
  const words = (n: number) => Array.from({ length: n }, () => WORDS[int(WORDS.length)]).join(" ");
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const body = (max: number) => {
    let s = "";
    const target = int(max + 1);
    while (s.length < target) s += words(3 + int(8)) + ". ";
    return s.slice(0, target);
  };
  // Order strings sort lexicographically; zero-padded index keeps feed order.
  const order = (i: number) => String(i).padStart(10, "0");

  const out: FeedChange[] = [];
  let seq = 0;

  const groupCount = Math.ceil(opts.lists / 8);
  const groupIds: string[] = [];
  for (let g = 0; g < groupCount; g++) {
    const id = uuid();
    groupIds.push(id);
    out.push({ kind: "list_group", id, seq: ++seq, deleted: false, data: { name: cap(words(2)), sort_key: new Date(todayMs - g * DAY_MS).toISOString() } });
  }

  const listIds: string[] = [];
  for (let l = 0; l < opts.lists; l++) {
    const id = uuid();
    listIds.push(id);
    const data: FeedList = {
      name: cap(words(1 + int(3))),
      sync: l % 10 === 5 ? "reference" : "todo",
      wellknown: null,
      is_owner: true,
      is_shared: false,
      group_id: chance(0.25) ? null : groupIds[l % groupCount],
      sort_key: new Date(todayMs - l * DAY_MS).toISOString(),
      theme: { color: null, background: null },
      image_id: null,
      image_style: null,
    };
    out.push({ kind: "list", id, seq: ++seq, deleted: false, data });
  }

  // Which task indexes are open: a seeded shuffle-free choice by quota.
  const openFlags = new Array<boolean>(opts.totalTasks).fill(false);
  let need = Math.min(opts.openTasks, opts.totalTasks);
  for (let i = 0; i < opts.totalTasks && need > 0; i++) {
    // Probability need / remaining guarantees exactly `need` picks.
    if (rnd() < need / (opts.totalTasks - i)) {
      openFlags[i] = true;
      need--;
    }
  }

  let myDayOrder = 0;
  for (let i = 0; i < opts.totalTasks; i++) {
    const open = openFlags[i];
    // Completions skew recent (exponential, mean ~120 days, capped at 2 years);
    // created precedes completion, and nothing is modified after today.
    const completedAgo = Math.min(730, Math.floor(-Math.log(1 - rnd()) * 120));
    const createdMs = open
      ? todayMs - (1 + int(730)) * DAY_MS - int(DAY_MS)
      : todayMs - completedAgo * DAY_MS - (1 + int(365)) * DAY_MS - int(DAY_MS);
    const created = new Date(createdMs).toISOString();
    const modifiedMs = open ? createdMs + int(30) * DAY_MS : todayMs - completedAgo * DAY_MS + int(DAY_MS);
    const modified = new Date(Math.min(modifiedMs, todayMs)).toISOString();
    const inMyDay = open && chance(0.05);
    const nSteps = chance(0.4) ? 1 + int(stepsMax) : 0;
    const data: FeedTask = {
      list_id: listIds[int(listIds.length)] ?? null,
      title: cap(words(2 + int(5))),
      status: open ? (chance(0.1) ? "inProgress" : "notStarted") : "completed",
      body: chance(0.6) && bodyMax > 0 ? { type: "text", content: body(bodyMax) } : null,
      importance: chance(0.1) ? "high" : chance(0.1) ? "low" : "normal",
      categories: chance(0.1) ? [words(1)] : [],
      due: chance(0.15) ? day(int(60) - 10) : null,
      start: null,
      reminder: { on: false, at: null },
      completed_at: open ? null : day(-completedAgo),
      recurrence: null,
      created_at: created,
      modified_at: modified,
      order: order(i),
      my_day: {
        committed_day: inMyDay ? today : null,
        committed_order: inMyDay ? order(++myDayOrder) : null,
        postponed_day: null,
      },
      subresources_complete: true,
      steps: Array.from({ length: nSteps }, (_, s) => {
        const checked = chance(0.3);
        return {
          id: uuid(),
          title: cap(words(2 + int(4))),
          checked,
          checked_at: checked ? modified : null,
          created_at: created,
          order: order(s),
        };
      }),
      links: [],
      attachments: [],
    };
    out.push({ kind: "task", id: uuid(), seq: ++seq, deleted: false, data, field_clock: {} });
  }
  return out;
}

// cursor is the decimal index of the next change; the terminal cursor is
// all.length, which stays stable (a further pull returns an empty page).
export function pageOf(all: FeedChange[], cursor: string | null, limit: number): FeedPage {
  const start = cursor === null ? 0 : Math.min(Math.max(0, Number(cursor) | 0), all.length);
  const changes: FeedChange[] = [];
  // Reserve the wrapper (cursor, has_more, backfill) so the whole page fits.
  let bytes = JSON.stringify({ cursor: String(all.length), has_more: true, changes: [], backfill: { remaining: 0 } }).length;
  let i = start;
  while (i < all.length && changes.length < limit) {
    const size = JSON.stringify(all[i]).length + 1;
    if (changes.length > 0 && bytes + size > PAGE_BYTE_BUDGET) break;
    changes.push(all[i]);
    bytes += size;
    i++;
  }
  return { cursor: String(i), has_more: i < all.length, changes, backfill: { remaining: 0 } };
}
