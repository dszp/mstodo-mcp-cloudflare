// A stand-in BFF for `pnpm run web:dev` (and Playwright): always signed in,
// with the spike's synthetic feed (workers/web/spike/fixture.ts) behind
// /bff/api/sync/changes. Wired into workers/web/vite.config.ts for the dev
// server only; the build never loads it. Nothing here is real data.
//
// Besides the spike's feed it adds a default list and a few tasks that show
// every detail field (reminder, repeat, links, files, an html note and a
// hostile one), and gives some lists a theme colour.
//
// `vite preview` (a built app) also gets the BFF, and every response there
// carries the production page CSP, so a build can be checked against it.
//
// Dataset size: POTEM_FAKE_TOTAL (default 2400) tasks, POTEM_FAKE_OPEN
// (default 545) of them open.
//
// POST /bff/api/sync/mutations applies the task, My Day and step ops to the
// fixture (see applyMutation) and appends each changed task to the feed, so
// the next pull sees it. The edits last until the server restarts or the date
// changes (the fixture is rebuilt each day).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";
import { generateFeed, pageOf } from "../../../spike/fixture.ts";
import type { FeedChange, FeedTask } from "../../sync/feed.ts";
import { todayIn } from "../loader.ts";
import { orderedSteps } from "../model.ts";

const TIMEZONE = "America/New_York";
const DAY_MS = 86_400_000;
const SEED = 1;
const LISTS = 40;
/** Exported for build.test.ts, which checks no build contains it. */
export const DATA_KEY = "ZmFrZS1kZXYtZGF0YS1rZXktbm90LWEtc2VjcmV0LTAw";
const CAPABILITIES = {
  my_day: true,
  step_order: true,
  sub_resources: true,
  list_appearance: true,
  list_appearance_write: true,
  attachment_download: true,
  attachment_upload: true,
  attachment_cache: false,
  theme_images: false,
  push: "none",
  source: "graph",
};

// The page CSP from workers/web/src/bff/headers.ts, with a made-up server
// origin. connect-src gets the preview server's own ws:// origin, derived
// from the request's Host as headers.ts derives wss:// from WEB_ORIGIN. A
// Host that isn't a plain host[:port] is left out rather than written into
// the header.
const pageCsp = (host: string | undefined) =>
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
  `connect-src 'self'${host && /^[A-Za-z0-9.-]+(:[0-9]+)?$/.test(host) ? ` ws://${host}` : ""}; ` +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://server.example.com";

const THEMES = ["dark_blue", "dark_red", "dark_teal", "light_purple", "dark_green", null, "beach", null];

/** The showcase: a default list and tasks with every field set. Made-up text only. */
function showcase(today: string): FeedChange[] {
  const day = (offset: number) => new Date(Date.parse(today) + offset * DAY_MS).toISOString().slice(0, 10);
  let seq = 1_000_000;
  const base = {
    list_id: "showcase-list", status: "notStarted", importance: "normal", categories: [], start: null,
    reminder: { on: false, at: null }, completed_at: null, recurrence: null,
    created_at: `${day(-3)}T15:04:05Z`, modified_at: `${day(-1)}T15:04:05Z`,
    my_day: { committed_day: null, committed_order: null, postponed_day: null },
    subresources_complete: true, steps: [], links: [], attachments: [], body: null, due: null,
  } satisfies Omit<FeedTask, "title" | "order">;
  const task = (id: string, order: string, over: Partial<FeedTask> & { title: string }): FeedChange => ({
    kind: "task", id, seq: ++seq, deleted: false, field_clock: {}, data: { ...base, order, ...over },
  });
  const step = (id: string, title: string, checked: boolean, order: string | null = null) => ({
    id, title, checked, checked_at: null, created_at: `${day(-3)}T15:0${id.length % 10}:00Z`, order,
  });
  return [
    {
      kind: "list", id: "showcase-list", seq: ++seq, deleted: false,
      data: {
        name: "Tasks", sync: "todo", wellknown: "defaultList", is_owner: true, is_shared: false, group_id: null,
        sort_key: null, theme: { color: "dark_blue", background: null }, image_id: null, image_style: null,
      },
    },
    task("showcase-1", "9999999999", {
      title: "Plan the example offsite",
      importance: "high",
      due: day(0),
      reminder: { on: true, at: `${day(0)}T19:00:00Z` },
      recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday", "thursday"] }, range: { type: "noEnd" } },
      my_day: { committed_day: today, committed_order: "9999999999", postponed_day: null },
      body: { type: "html", content: "<div>Agenda draft at https://example.com/agenda.</div><div><br></div><div>Questions to mailto:someone@example.com&nbsp;by Friday.</div>" },
      steps: [
        step("st-a", "Pick a date", true),
        step("st-b", "Set the budget", false),
        step("st-c", "Book the venue, a step with a title long enough to wrap onto a second line", false),
      ],
      links: [{ id: "ln-1", url: "https://example.com/ticket/42", title: "Ticket 42", app: "Example Desk", external_id: null }],
      attachments: [{ id: "att-1", name: "agenda.txt", size: 325, content_type: "text/plain" }],
    }),
    task("showcase-2", "9999999998", {
      title: "A note that tries to run script",
      due: day(-1),
      body: { type: "html", content: '<img src=x onerror=alert(1)>Plain words stay.<script>alert(2)</script> <a href="javascript:alert(3)">click</a>' },
      links: [
        { id: "ln-2", url: "javascript:alert(4)", title: "Not a link", app: null, external_id: null },
        { id: "ln-3", url: "data:text/html,<b>x</b>", title: "Not a link either", app: null, external_id: null },
      ],
    }),
    task("showcase-3", "9999999997", {
      title: "A text note with lines",
      body: { type: "text", content: "First line\nSecond line <b>stays as typed</b>\n\nhttps://example.com/after-a-blank" },
      due: day(5),
    }),
    task("showcase-4", "9999999996", {
      title: "Finished example",
      status: "completed",
      completed_at: today,
      my_day: { committed_day: today, committed_order: "1", postponed_day: null },
    }),
  ];
}

/**
 * Completed tasks older than the active scope: the server finds them
 * (/search, /tasks/{sid}), the feed doesn't carry them. Made-up text only.
 */
function oldTasks(today: string): FeedChange[] {
  const day = (offset: number) => new Date(Date.parse(today) - offset * DAY_MS).toISOString().slice(0, 10);
  const old = (n: number, over: Partial<FeedTask> & { title: string }): FeedChange => ({
    kind: "task", id: `old-${n}`, seq: 2_000_000 + n, deleted: false, field_clock: {},
    data: {
      list_id: "showcase-list", status: "completed", importance: "normal", categories: [], start: null, due: null,
      reminder: { on: false, at: null }, completed_at: `${day(120 + n)}T15:00:00Z`, recurrence: null,
      created_at: `${day(200 + n)}T15:00:00Z`, modified_at: `${day(120 + n)}T15:00:00Z`, order: `${1000 + n}`,
      my_day: { committed_day: null, committed_order: null, postponed_day: null },
      subresources_complete: true, steps: [], links: [], attachments: [], body: null, ...over,
    },
  });
  return [
    old(1, {
      title: "Renew the example license",
      body: { type: "text", content: "Renewed last spring. Details at https://example.com/licenses." },
      steps: [{ id: "old-st-1", title: "Send the form", checked: true, checked_at: null, created_at: `${day(200)}T15:00:00Z`, order: null }],
    }),
    old(2, { title: "Example offsite budget review", due: day(150) }),
    old(3, { title: "<b>Old</b> <img src=x onerror=alert(1)> example title", importance: "high" }),
    old(4, { title: "Archive the example notes", links: [{ id: "old-ln", url: "https://example.com/notes", title: "Notes", app: null, external_id: null }] }),
  ];
}

type TaskChange = Extract<FeedChange, { kind: "task"; deleted: false }>;
type Mutation = {
  id?: unknown;
  op?: unknown;
  sid?: unknown;
  fields?: Record<string, unknown>;
  position?: { before?: string; after?: string; top?: true; bottom?: true };
};
type Result = { id: unknown; status: "applied"; sid: string } | { id: unknown; status: "rejected"; error: string };

/** The BFF's limit (MUTATIONS_MAX_BYTES in workers/web/src/bff/api.ts). */
const MUTATIONS_MAX_BYTES = 256 * 1024;
const FAKE_OPS = [
  "task.create", "task.update", "task.delete", "task.move", "myday.add", "myday.remove",
  "step.create", "step.update", "step.delete", "step.reorder",
];
const TASK_FIELDS = ["title", "body", "status", "completed_at", "importance", "due", "start", "reminder", "categories", "recurrence"];

/**
 * One mutation against the "server's" tasks: the new task data, null for a
 * delete, or the reason it is rejected. A simplified copy of the server's ops
 * (packages/core/sync/mutations.ts): no field clocks, no Graph rules beyond
 * completion's date, and positions only for steps. Ops the web client doesn't
 * send yet (lists, links, attachments, task and My Day reorders) are rejected.
 */
function applyMutation(
  m: Mutation,
  find: (sid: string) => TaskChange | undefined,
  findStep: (sid: string) => TaskChange | undefined,
  today: string,
  now: string,
): { sid: string; data: FeedTask | null } | string {
  if (typeof m.op !== "string" || !FAKE_OPS.includes(m.op)) return "unknown_op";
  if (typeof m.sid !== "string" || m.sid === "") return "missing_sid";
  const sid = m.sid;
  const f = m.fields ?? {};
  const pick = (names: string[]) => Object.fromEntries(Object.entries(f).filter(([k]) => names.includes(k)));
  // Completing without a date gets the owner's today, as the server stamps it (SYNC-API section 6).
  const completion = (data: FeedTask): FeedTask =>
    data.status === "completed" ? { ...data, completed_at: data.completed_at ?? today } : { ...data, completed_at: null };

  if (m.op === "task.create") {
    if (find(sid)) return "sid_exists";
    if (typeof f.list_id !== "string" || typeof f.title !== "string") return "invalid_field:list_id";
    return {
      sid,
      data: completion({
        list_id: f.list_id, title: f.title, status: "notStarted", body: null, importance: "normal", categories: [],
        due: null, start: null, reminder: { on: false, at: null }, completed_at: null, recurrence: null,
        created_at: now, modified_at: now, order: String(Date.now()),
        my_day: { committed_day: null, committed_order: null, postponed_day: null },
        subresources_complete: true, steps: [], links: [], attachments: [],
        ...(pick(TASK_FIELDS) as Partial<FeedTask>),
      }),
    };
  }
  if (m.op.startsWith("step.")) {
    const owner = m.op === "step.create" ? find(typeof f.task_id === "string" ? f.task_id : "") : findStep(sid);
    if (!owner) return "not_found";
    let steps = [...owner.data.steps];
    if (m.op === "step.create") {
      steps.push({ id: sid, title: typeof f.title === "string" ? f.title : "", checked: f.checked === true, checked_at: null, created_at: now, order: null });
    } else if (m.op === "step.update") {
      steps = steps.map((s) => (s.id === sid ? { ...s, ...(pick(["title", "checked"]) as Partial<typeof s>) } : s));
    } else if (m.op === "step.delete") {
      steps = steps.filter((s) => s.id !== sid);
    } else if (m.op === "step.reorder") {
      // Put the step where `position` says in the shown order, then number
      // every step in that order, latest first, as To Do's OrderDateTime does.
      const shown = orderedSteps(steps);
      const moved = shown.find((s) => s.id === sid)!;
      const rest = shown.filter((s) => s.id !== sid);
      const p = m.position ?? {};
      const ref = p.before ?? p.after;
      let at = p.top ? 0 : p.bottom ? rest.length : rest.findIndex((s) => s.id === ref);
      if (at === -1) return "unknown_position";
      if (p.after) at++;
      rest.splice(at, 0, moved);
      const base = Date.now();
      steps = rest.map((s, i) => ({ ...s, order: new Date(base - i * 1000).toISOString() }));
    } else {
      return "unknown_op";
    }
    return { sid: owner.id, data: { ...owner.data, steps, modified_at: now } };
  }
  const task = find(sid);
  if (!task) return "not_found";
  const data = task.data;
  switch (m.op) {
    case "task.update":
      return { sid, data: completion({ ...data, ...(pick(TASK_FIELDS) as Partial<FeedTask>), modified_at: now }) };
    case "task.delete":
      return { sid, data: null };
    case "task.move":
      if (typeof f.list_id !== "string") return "invalid_field:list_id";
      return { sid, data: { ...data, list_id: f.list_id, modified_at: now } };
    case "myday.add":
      return { sid, data: { ...data, my_day: { ...data.my_day, committed_day: today, committed_order: String(Date.now()) }, modified_at: now } };
    case "myday.remove":
      return { sid, data: { ...data, my_day: { ...data.my_day, committed_day: null, committed_order: null }, modified_at: now } };
  }
  return "unknown_op";
}

function envCount(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, not ${JSON.stringify(raw)}`);
  return n;
}

export function fakeBff(): Plugin {
  const total = envCount("POTEM_FAKE_TOTAL", 2400);
  const open = Math.min(envCount("POTEM_FAKE_OPEN", 545), total);
  // One feed per day, so My Day and Planned follow the real date.
  let cached: { today: string; feed: FeedChange[]; everything: FeedChange[] } | null = null;
  const feed = (): FeedChange[] => {
    const today = todayIn(TIMEZONE, new Date());
    if (cached?.today !== today) {
      // The active scope: open tasks and tasks completed in the last 30 days.
      const since = new Date(Date.parse(today) - 30 * DAY_MS).toISOString().slice(0, 10);
      const all = generateFeed({ totalTasks: total, openTasks: open, lists: LISTS, seed: SEED, today });
      let n = 0;
      for (const c of all) if (c.kind === "list" && !c.deleted) c.data.theme = { color: THEMES[n++ % THEMES.length]!, background: null };
      all.push(...showcase(today));
      const active = all.filter(
        (c) => c.kind !== "task" || c.deleted || c.data.status !== "completed" || (c.data.completed_at !== null && c.data.completed_at >= since),
      );
      cached = { today, feed: active, everything: [...all, ...oldTasks(today)] };
    }
    return cached.feed;
  };
  // Every task the "server" holds: the feed's, the completed ones it left out, and the old ones.
  const everyTask = (): Array<Extract<FeedChange, { kind: "task" }>> => {
    feed();
    return cached!.everything.filter((c): c is Extract<FeedChange, { kind: "task" }> => c.kind === "task" && !c.deleted);
  };

  let seq = 3_000_000;
  /**
   * POST /bff/api/sync/mutations. Each applied edit appends the task's new
   * state (or its deletion) to the feed and replaces it among every task the
   * "server" holds. The returned cursor is the feed position of the first
   * appended change, so a pull from it, or from any earlier cursor, shows the
   * edits. The real server returns the cursor after the batch; the page pulls
   * from its own cursor either way.
   */
  function mutate(batch: { mutations?: Mutation[] }): { cursor: string; results: Result[] } {
    const changes = feed();
    const cursor = String(changes.length);
    const everything = cached!.everything;
    const today = cached!.today;
    const isTask = (c: FeedChange): c is TaskChange => c.kind === "task" && !c.deleted;
    const find = (sid: string) => everything.find((c): c is TaskChange => isTask(c) && c.id === sid);
    const findStep = (sid: string) => everything.find((c): c is TaskChange => isTask(c) && c.data.steps.some((s) => s.id === sid));
    const results: Result[] = [];
    for (const m of Array.isArray(batch.mutations) ? batch.mutations : []) {
      const out = applyMutation(m, find, findStep, today, new Date().toISOString());
      if (typeof out === "string") {
        results.push({ id: m.id, status: "rejected", error: out });
        continue;
      }
      const at = everything.findIndex((c) => isTask(c) && c.id === out.sid);
      if (out.data === null) {
        everything.splice(at, 1);
        changes.push({ kind: "task", id: out.sid, seq: ++seq, deleted: true });
      } else {
        const change: TaskChange = { kind: "task", id: out.sid, seq: ++seq, deleted: false, field_clock: {}, data: out.data };
        if (at === -1) everything.push(change);
        else everything[at] = change;
        changes.push(change);
      }
      results.push({ id: m.id, status: "applied", sid: typeof m.sid === "string" ? m.sid : out.sid });
    }
    return { cursor, results };
  }

  /** The request body as JSON, or the status that refuses it. */
  async function readBatch(req: IncomingMessage): Promise<unknown> {
    let total = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > MUTATIONS_MAX_BYTES) return 413;
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return 400;
    }
  }

  async function postMutations(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The BFF's checks, so a page that forgets a header fails here too. Origin
    // isn't checked: the dev server's origin varies.
    if (req.headers["x-potem"] !== "1") return send(res, 403, { error: "forbidden" });
    const media = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (media !== "application/json") return send(res, 415, { error: "unsupported_media_type" });
    const batch = await readBatch(req);
    if (batch === 413) return send(res, 413, { error: "body_too_large", max: MUTATIONS_MAX_BYTES });
    if (batch === 400 || typeof batch !== "object" || batch === null) return send(res, 400, { error: "bad_json" });
    return send(res, 200, mutate(batch as { mutations?: Mutation[] }));
  }

  function send(res: ServerResponse, status: number, body?: unknown): void {
    res.statusCode = status;
    res.setHeader("cache-control", "no-store");
    if (body === undefined) {
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }

  function handle(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /bff/session": {
        const now = Math.floor(Date.now() / 1000);
        return send(res, 200, {
          signed_in: true,
          expires_at: now + 12 * 3600,
          idle_minutes: 60,
          refresh_at: now + 3540,
          now,
          data_key: DATA_KEY,
        });
      }
      case "POST /bff/session/refresh":
      case "POST /auth/logout":
        return send(res, 204);
      case "GET /auth/login":
        res.statusCode = 302;
        res.setHeader("location", "/");
        res.setHeader("cache-control", "no-store");
        res.end();
        return;
      case "GET /bff/api/sync/info":
        return send(res, 200, {
          server_id: "dev",
          cursor: "0",
          account: { name: "Dev Owner", email_hint: "d…@example.com" },
          version: "dev",
          capabilities: CAPABILITIES,
          link_rules_rev: null,
          timezone: TIMEZONE,
        });
      case "POST /bff/api/sync/mutations":
        postMutations(req, res).catch(next);
        return;
      case "GET /bff/api/sync/changes": {
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 500) | 0));
        return send(res, 200, pageOf(feed(), url.searchParams.get("cursor"), limit));
      }
    }
    if (req.method === "GET" && url.pathname === "/bff/api/search") {
      // Every word a case-folded substring of the title, like the server's prefix match, 50 at most.
      const words = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0 || words.join(" ").length > 256) return send(res, 400, { error: "bad_query" });
      const hits = everyTask().filter((t) => words.every((w) => t.data.title.toLowerCase().includes(w))).slice(0, 50);
      return send(res, 200, { results: hits });
    }
    const one = req.method === "GET" ? /^\/bff\/api\/tasks\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname) : null;
    if (one) {
      const hit = everyTask().find((t) => t.id === one[1]);
      return hit ? send(res, 200, hit) : send(res, 404, { error: "not_found" });
    }
    if (url.pathname.startsWith("/bff/") || url.pathname.startsWith("/auth/")) {
      return send(res, 404, { error: "not_found" });
    }
    next();
  }

  // The fake BFF has no push socket. A WebSocket upgrade never reaches the
  // middlewares, and Vite leaves one it doesn't own hanging, so /bff/socket
  // is refused at once: the page's push client backs off (up to 30 s between
  // tries) and the page stays on the 30 s poll.
  function refuseSocket(req: IncomingMessage, socket: Duplex): void {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/bff/socket") return;
    socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  }

  return {
    name: "potem-fake-bff",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.on("upgrade", refuseSocket);
      server.middlewares.use(handle);
    },
    // The dev server can't run under the page CSP (Vite injects inline script
    // and style), so the CSP check runs against a build: `vite preview`.
    configurePreviewServer(server) {
      server.httpServer.on("upgrade", refuseSocket);
      server.middlewares.use((req, res, next) => {
        res.setHeader("content-security-policy", pageCsp(req.headers.host));
        next();
      });
      server.middlewares.use(handle);
    },
  };
}
