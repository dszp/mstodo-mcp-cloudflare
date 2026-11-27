import { createRoot } from "react-dom/client";
import { MirrorStore } from "../src/sync/store";
import { pullAll, type FetchPage } from "../src/sync/pull";
import type { FeedPage } from "../src/sync/feed";
import { App, publishStats, type Stats } from "./App";

declare global {
  interface Window { __spike?: Stats; __spikeStore?: MirrorStore }
}

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const total = Number(q.get("total") ?? 2400);
  const open = Number(q.get("open") ?? 545);
  const scope = q.get("scope") === "all" ? "all" : "active";
  const dataset = new URLSearchParams({ total: String(total), open: String(open), lists: q.get("lists") ?? "40", scope });
  const { today } = (await (await fetch("/spike/meta")).json()) as { today: string };

  const store = new MirrorStore();
  window.__spikeStore = store;
  let fetchMs = 0;
  let applyMs = 0;
  const fetchPage: FetchPage = async (cursor) => {
    const url = `/bff/api/sync/changes?${dataset}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const t0 = performance.now();
    const res = await fetch(url, { cache: "no-store" });
    const page = (await res.json()) as FeedPage;
    fetchMs += performance.now() - t0;
    return { ok: true, page };
  };
  const realApply = store.applyPage.bind(store);
  store.applyPage = (changes) => {
    const t0 = performance.now();
    realApply(changes);
    applyMs += performance.now() - t0;
  };

  const pulled = await pullAll(fetchPage, store, null);
  const pullEnd = performance.now();
  const base = { total, open, scope, pages: pulled.pages, changes: pulled.changes, fetchMs, applyMs };
  let done = false;
  createRoot(document.getElementById("root")!).render(
    <App
      store={store}
      today={today}
      stats={base}
      onFirstRows={() => {
        if (done) return;
        done = true;
        requestAnimationFrame(() => {
          const now = performance.now();
          const s: Stats = { ...base, firstRenderMs: now - pullEnd, totalMs: now }; // performance.now() is relative to timeOrigin
          window.__spike = s;
          publishStats(s);
        });
      }}
    />,
  );
}

void main();
