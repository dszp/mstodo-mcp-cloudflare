// The URL is the view: which list is shown, which task is open, what is being
// searched. Plain History API; no router library.
//
//   /                          My Day
//   /smart/<smart list>        a smart list (SmartList in core's feed types)
//   /list/<id>                 one list
//   ?task=<id>                 on any of the above: the task open in the detail pane
//   /search?q=<text>[&all=1]   search (no ?task); all=1 asks the server too (Task 8)

import type { SmartList } from "../sync/feed.ts";

export type Route =
  | { view: "smart"; list: SmartList; task?: string }
  | { view: "list"; id: string; task?: string }
  | { view: "search"; q: string; all: boolean };

// The id shape the BFF allowlists (workers/web/src/bff/api.ts).
const ID = /^[A-Za-z0-9_-]{1,128}$/;
// Keyed by SmartList, so the compiler checks it names exactly core's smart
// lists; a type-only import keeps core out of the bundle (the app's Vite
// config has no @potem/core alias).
const SMART_LIST_NAMES: Record<SmartList, true> = { my_day: true, important: true, planned: true, all: true, completed: true };
const isSmartList = (s: string): s is SmartList => Object.hasOwn(SMART_LIST_NAMES, s);

/** The route a URL names, or null for one the app doesn't know (shown as /). */
export function parseRoute(url: URL): Route | null {
  const parts = url.pathname.split("/").slice(1);
  if (url.pathname === "/search") {
    return { view: "search", q: url.searchParams.get("q") ?? "", all: url.searchParams.get("all") === "1" };
  }
  let base: Route;
  if (url.pathname === "/") base = { view: "smart", list: "my_day" };
  else if (parts.length === 2 && parts[0] === "smart" && isSmartList(parts[1])) base = { view: "smart", list: parts[1] };
  else if (parts.length === 2 && parts[0] === "list" && ID.test(parts[1])) base = { view: "list", id: parts[1] };
  else return null;
  const task = url.searchParams.get("task");
  if (task === null) return base;
  return ID.test(task) ? { ...base, task } : null;
}

export function formatRoute(route: Route): string {
  if (route.view === "search") {
    const q = new URLSearchParams({ q: route.q });
    if (route.all) q.set("all", "1");
    return `/search?${q}`;
  }
  const path = route.view === "list" ? `/list/${route.id}` : route.list === "my_day" ? "/" : `/smart/${route.list}`;
  return route.task === undefined ? path : `${path}?${new URLSearchParams({ task: route.task })}`;
}

const MY_DAY: Route = { view: "smart", list: "my_day" };

/** The route in the address bar now; an unknown URL reads as My Day. */
export function currentRoute(): Route {
  return parseRoute(new URL(window.location.href)) ?? MY_DAY;
}

const routeListeners = new Set<() => void>();

/** Shows `route`, adding a history entry. */
export function navigate(route: Route): void {
  const next = formatRoute(route);
  if (next !== window.location.pathname + window.location.search) window.history.pushState(null, "", next);
  for (const cb of [...routeListeners]) cb();
}

/** Shows `route` in place of the current history entry (closing a task adds no entry). */
export function replaceRoute(route: Route): void {
  window.history.replaceState(null, "", formatRoute(route));
  for (const cb of [...routeListeners]) cb();
}

/** Calls `cb` on navigate(), replaceRoute() and on back/forward. */
export function subscribeRoute(cb: () => void): () => void {
  routeListeners.add(cb);
  window.addEventListener("popstate", cb);
  return () => {
    routeListeners.delete(cb);
    window.removeEventListener("popstate", cb);
  };
}
