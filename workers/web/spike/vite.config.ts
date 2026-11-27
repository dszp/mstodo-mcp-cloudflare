import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { generateFeed, pageOf } from "./fixture";
import type { FeedChange } from "../src/sync/feed";

const TODAY = "2026-11-27";
const DAY_MS = 86_400_000;
const SEED = 1;

// Throwaway spike server: serves a synthetic change feed at the same path the
// real BFF will use. The feed is generated once per distinct query so repeated
// runs measure the client, not the generator.
function spikeFeed(): Plugin {
  const cache = new Map<string, FeedChange[]>();
  const feedFor = (q: URLSearchParams): FeedChange[] => {
    const total = Number(q.get("total") ?? 2400);
    const open = Number(q.get("open") ?? 545);
    const lists = Number(q.get("lists") ?? 40);
    const scope = q.get("scope") === "all" ? "all" : "active";
    const key = `${total}/${open}/${lists}/${scope}`;
    let feed = cache.get(key);
    if (!feed) {
      feed = generateFeed({ totalTasks: total, openTasks: open, lists, seed: SEED, today: TODAY });
      if (scope === "active") {
        const since = new Date(Date.parse(TODAY) - 30 * DAY_MS).toISOString().slice(0, 10);
        feed = feed.filter((c) => {
          if (c.kind !== "task" || c.deleted) return true;
          return c.data.status !== "completed" || (c.data.completed_at !== null && c.data.completed_at >= since);
        });
      }
      cache.set(key, feed);
    }
    return feed;
  };
  return {
    name: "spike-feed",
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
  function handle(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/spike/meta") {
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ today: TODAY }));
      return;
    }
    if (url.pathname === "/bff/api/sync/changes") {
      const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 500) | 0);
      const cursor = url.searchParams.get("cursor") || null;
      // The dataset params ride along on every page request (the page adds them).
      const body = JSON.stringify(pageOf(feedFor(url.searchParams), cursor, limit));
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(body);
      return;
    }
    next();
  }
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), spikeFeed()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
