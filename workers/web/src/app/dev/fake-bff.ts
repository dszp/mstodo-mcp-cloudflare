// A stand-in BFF for `npm run web:dev` (and Playwright): always signed in,
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

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { generateFeed, pageOf } from "../../../spike/fixture.ts";
import type { FeedChange, FeedTask } from "../../sync/feed.ts";
import { todayIn } from "../loader.ts";

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

// The page CSP from workers/web/src/bff/headers.ts, with a made-up server origin.
const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
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
  let cached: { today: string; feed: FeedChange[] } | null = null;
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
      cached = { today, feed: active };
    }
    return cached.feed;
  };

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
      case "GET /bff/session":
        return send(res, 200, { signed_in: true, expires_at: Math.floor(Date.now() / 1000) + 12 * 3600, data_key: DATA_KEY });
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
      case "GET /bff/api/sync/changes": {
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 500) | 0));
        return send(res, 200, pageOf(feed(), url.searchParams.get("cursor"), limit));
      }
    }
    if (url.pathname.startsWith("/bff/") || url.pathname.startsWith("/auth/")) {
      return send(res, 404, { error: "not_found" });
    }
    next();
  }

  return {
    name: "potem-fake-bff",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(handle);
    },
    // The dev server can't run under the page CSP (Vite injects inline script
    // and style), so the CSP check runs against a build: `vite preview`.
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("content-security-policy", PAGE_CSP);
        next();
      });
      server.middlewares.use(handle);
    },
  };
}
