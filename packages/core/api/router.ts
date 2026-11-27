// The client sync API's routes (docs/SYNC-API.md sections 4, 5, 14.1, 18.7),
// shared by both hosts: the reads here, POST /sync/mutations in ./mutations.ts.
// The OAuth front (workers/server/src/hosts/shared/oauth.ts) mounts them: handlePublicApiRequest before the /api/v1 resource server, and
// handleApiRequest as that resource server's handler, so every request that
// reaches handleApiRequest carries a valid token whose audience is /api/v1.
import { refuseApiRequest } from "../auth/grant";
import { loadIdentity } from "../auth/microsoft";
import { ownerIndex } from "../owner-index";
import type { AppEnv } from "../ports";
import type { Props } from "../types";
import { VERSION } from "../version";
import { attachmentBySid } from "./attachments";
import { currentLinkRules, linkRulesRoute } from "./link-rules";
import { syncMutations, type BackgroundWork } from "./mutations";
import { json } from "./respond";
import { themeImageBytes, uploadAttachment, uploadThemeImage } from "./uploads";

export const API_PATH = "/api/v1";

// Search hits are returned as whole tasks, one index read each.
export const SEARCH_LIMIT = 50;
const MAX_QUERY_CHARS = 256;
const MAX_QUERY_TERMS = 16;
// sids are UUIDs; anything else can't name a task.
const SID_RE = /^[0-9A-Za-z-]{1,64}$/;

const error = (code: string, status: number) => json({ error: code }, status);

// The one route that answers without a token: the app probes a server before
// signing in, to learn its server_id and that it exists. Nothing else is
// disclosed before sign-in (section 18.7). A request that sends a bearer goes
// through the resource server instead, so a bad token gets the 401 challenge.
// Returns null for every other request.
// server_id never changes, so an isolate asks the index once; anonymous
// probes don't each queue a request on the index object.
let cachedServerId: string | null = null;

export async function handlePublicApiRequest(req: Request, env: AppEnv): Promise<Response | null> {
  if (req.method !== "GET" || req.headers.has("authorization")) return null;
  if (new URL(req.url).pathname !== `${API_PATH}/sync/info`) return null;
  cachedServerId ??= (await ownerIndex(env).syncInfo()).server_id;
  return json({ server_id: cachedServerId });
}

// An authenticated /api/v1 request. The grant gate (epoch, age, pending
// Microsoft re-auth) runs first, the same check /mcp applies. `bg` keeps a
// write running after the client disconnects (the host's waitUntil).
export async function handleApiRequest(
  req: Request,
  env: AppEnv,
  props: Partial<Props> | undefined,
  bg: BackgroundWork,
): Promise<Response> {
  const refused = await refuseApiRequest(env, props);
  if (refused) return refused;

  const url = new URL(req.url);
  const path = url.pathname.slice(API_PATH.length);
  if (path === "/sync/mutations") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return syncMutations(req, env, props, bg);
  }
  // The two binary uploads (sections 4.8 and 5.6).
  if (path === "/attachments" || path === "/theme-images") {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    return path === "/attachments" ? uploadAttachment(req, env, props) : uploadThemeImage(req, env);
  }
  const image = /^\/theme-images\/([^/]+)$/.exec(path);
  if (image && req.method === "GET") return themeImageBytes(image[1], req, env);
  const route = image ? null : matchRoute(path);
  if (!route && !image) return error("not_found", 404);
  if (req.method !== "GET" || !route) return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
  return route(url, env);
}

type Route = (url: URL, env: AppEnv) => Promise<Response>;

function matchRoute(path: string): Route | null {
  if (path === "/sync/changes") return syncChanges;
  if (path === "/sync/info") return syncInfo;
  if (path === "/search") return search;
  if (path === "/lists/excluded") return excludedLists;
  if (path === "/link-rules") return linkRulesRoute;
  const task = /^\/tasks\/([^/]+)$/.exec(path);
  if (task) return (_url, env) => taskBySid(task[1], env);
  const attachment = /^\/attachments\/([^/]+)$/.exec(path);
  if (attachment) return (_url, env) => attachmentBySid(attachment[1], env);
  return null;
}

// GET /api/v1/sync/changes?cursor=&limit=&scope= — one page of the change feed.
async function syncChanges(url: URL, env: AppEnv): Promise<Response> {
  const q = url.searchParams;
  const rawLimit = q.get("limit");
  if (rawLimit !== null && !/^\d{1,6}$/.test(rawLimit)) return error("bad_limit", 400);
  const result = await ownerIndex(env).syncChanges({
    cursor: q.get("cursor"),
    limit: rawLimit === null ? undefined : Number(rawLimit),
    scope: q.get("scope") ?? undefined,
  });
  if (result.ok) return json(result.page);
  // 410: the client discards its cursor and runs a full sync (section 4.3).
  const status = result.error === "cursor_reset" || result.error === "cursor_expired" ? 410 : 400;
  return error(result.error, status);
}

// GET /api/v1/lists/excluded — lists whose sync setting is excluded. The feed
// never carries them, so the app lists them here and can switch one back on
// with list.update { sync } (section 1.2).
async function excludedLists(_url: URL, env: AppEnv): Promise<Response> {
  return json({ lists: await ownerIndex(env).excludedLists() });
}

// GET /api/v1/tasks/{sid} — one task, for a search hit or an out-of-scope link.
async function taskBySid(rawSid: string, env: AppEnv): Promise<Response> {
  let sid: string;
  try {
    sid = decodeURIComponent(rawSid);
  } catch {
    return error("not_found", 404);
  }
  if (!SID_RE.test(sid)) return error("not_found", 404);
  const task = await ownerIndex(env).syncTask(sid);
  return task ? json({ kind: "task", ...task }) : error("not_found", 404);
}

// GET /api/v1/search?q= — the index's FTS search over every task, whatever
// the device's scope, answered with tasks shaped like the feed's. The query is
// plain text typed by a person, not FTS syntax: see ftsTerms.
async function search(url: URL, env: AppEnv): Promise<Response> {
  const raw = url.searchParams.get("q") ?? "";
  const query = raw.length <= MAX_QUERY_CHARS ? ftsTerms(raw) : "";
  if (!query) return error("bad_query", 400);
  const tasks = await ownerIndex(env).syncSearch(query, SEARCH_LIMIT);
  return json({ results: tasks.map((t) => ({ kind: "task", ...t })) });
}

// Plain text → an FTS5 query: every word must appear, each as a prefix (so
// search-as-you-type matches), with quotes and operators taken literally.
// Each word is a quoted string ("" escapes a quote inside one), so nothing a
// person types can be FTS syntax or a syntax error. "" when there are no words.
export function ftsTerms(text: string): string {
  return text
    // FTS5 ends a query string at NUL, so control characters become spaces.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_QUERY_TERMS)
    .map((w) => `"${w.replaceAll('"', '""')}"*`)
    .join(" ");
}

// GET /api/v1/sync/info with a token: everything the app needs to set up and
// label the account (section 14.1). The owner's address is sent as a hint.
async function syncInfo(_url: URL, env: AppEnv): Promise<Response> {
  const [info, identity, linkRules] = await Promise.all([
    ownerIndex(env).syncInfo(),
    loadIdentity(env),
    // Stored rules that no longer parse mustn't take /sync/info down with
    // them; the app then keeps the rules it has (section 4.7).
    currentLinkRules(env).catch(() => null),
  ]);
  return json({
    server_id: info.server_id,
    cursor: info.cursor,
    account: { name: identity?.displayName ?? null, email_hint: emailHint(info.account.email) },
    version: VERSION,
    capabilities: info.capabilities,
    link_rules_rev: linkRules?.rev ?? null,
    // The zone the feed's bare dates are in, and the one a client's "today"
    // uses (section 4.10). Unset means UTC, as the change feed reads it.
    timezone: env.TIMEZONE || "UTC",
  });
}

// "david@example.com" → "d…@example.com": enough to tell accounts apart.
export function emailHint(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  return `${email[0]}…${email.slice(at)}`;
}
