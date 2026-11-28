// A stand-in BFF for `npm run web:dev` (and Playwright): always signed in,
// with the spike's synthetic feed (workers/web/spike/fixture.ts) behind
// /bff/api/sync/changes. Wired into workers/web/vite.config.ts for the dev
// server only; the build never loads it. Nothing here is real data.
//
// Dataset size: POTEM_FAKE_TOTAL (default 2400) tasks, POTEM_FAKE_OPEN
// (default 545) of them open.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { generateFeed, pageOf } from "../../../spike/fixture.ts";
import type { FeedChange } from "../../sync/feed.ts";
import { todayIn } from "../loader.ts";

const TIMEZONE = "America/New_York";
const DAY_MS = 86_400_000;
const SEED = 1;
const LISTS = 40;
const DATA_KEY = "ZmFrZS1kZXYtZGF0YS1rZXktbm90LWEtc2VjcmV0LTAw";
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
  };
}
