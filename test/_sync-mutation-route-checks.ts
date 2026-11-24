// POST /api/v1/sync/mutations through a host's whole OAuth front, with Graph
// scripted at fetch: a real /api/v1 token, the route, applyBatch on the real
// index (the TodoIndex DO over RPC on Workers, in-process IndexCore on Node),
// the executor and the ops. Run by test/sync-mutations-route.test.ts and
// test-node/sync-mutations-route.test.ts. The env given here must have My Day
// off and the checklist cache on.
import { expect } from "vitest";
import { GraphClient } from "../src/core/graph/client";
import { opsContext } from "../src/core/ops/context";
import { createList } from "../src/core/ops/lists";
import { ownerIndex } from "../src/core/owner-index";
import type { AppEnv } from "../src/core/ports";
import { ORIGIN, oauthClient, stubMicrosoft } from "../test-node/_oauth-client";

const G = "https://graph.microsoft.com/v1.0/me/todo/lists";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const graphTask = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `title ${id}`,
  status: "notStarted",
  lastModifiedDateTime: new Date().toISOString(),
  ...extra,
});

// App-chosen sids.
const TASK = "0190a1b2-c3d4-7e5f-8a9b-000000000001";
const STEP = "0190a1b2-c3d4-7e5f-8a9b-000000000002";
const LINK = "0190a1b2-c3d4-7e5f-8a9b-000000000003";

type Result = { id: string; status: string; sid?: string; error?: string; retry?: boolean; superseded_fields?: string[] };

export async function runSyncMutationRouteChecks(
  env: AppEnv,
  fetchFn: (req: Request) => Promise<Response>,
  opts: { deferred?: () => number } = {},
) {
  // Graph, scripted per test step. `hold` parks a request until released.
  const graphCalls: Array<{ method: string; url: string; body: unknown }> = [];
  let hold: { url: string; until: Promise<void>; reached: () => void } | null = null;
  let throttle = false;
  stubMicrosoft("test-owner@example.com", async (url, init) => {
    if (!url.startsWith(G)) return undefined;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    graphCalls.push({ method, url, body });
    if (hold && url === hold.url) {
      hold.reached();
      await hold.until;
    }
    if (throttle) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
    if (method === "POST" && url === G) return json({ id: "L-mcp", displayName: body.displayName }, 201);
    if (method === "POST" && url === `${G}/L1/tasks`) return json(graphTask("GT1", body), 201);
    if (method === "PATCH" && url === `${G}/L1/tasks/GT1`) return json(graphTask("GT1", body));
    if (method === "PATCH" && url === `${G}/L1/tasks/T3`) return json(graphTask("T3", body));
    // The completion-date check and the link rules' re-fetch read the task.
    const read = /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/todo\/lists\/L1\/tasks\/(\w+)(\?.*)?$/.exec(url);
    if (method === "GET" && read) return json(graphTask(read[1]));
    if (method === "POST" && url === `${G}/L1/tasks/GT1/checklistItems`) return json({ id: "S1", ...body }, 201);
    if (method === "PATCH" && url === `${G}/L1/tasks/GT1/checklistItems/S1`) return json({ id: "S1", ...body });
    if (method === "POST" && url === `${G}/L1/tasks/GT1/linkedResources`) return json({ id: "K1", ...body }, 201);
    if (method === "PATCH" && url === `${G}/L1/tasks/GT1/linkedResources/K1`) return json({ id: "K1", ...body });
    if (method === "DELETE" && url === `${G}/L1/tasks/GT1`) return new Response(null, { status: 204 });
    // T2 is in the mirror but already gone from Graph.
    if (method === "DELETE" && url === `${G}/L1/tasks/T2`) {
      return json({ error: { code: "ErrorItemNotFound" } }, 404);
    }
    return json({ error: { code: "Unscripted" } }, 418);
  });

  const index = ownerIndex(env);
  await index.upsertList({ id: "L1", displayName: "One" } as never);
  await index.upsertTask(graphTask("T2") as never, "L1");
  await index.upsertTask(graphTask("T3") as never, "L1");

  const client = oauthClient(fetchFn);
  const post = (body: unknown, token?: string) =>
    client.send("/api/v1/sync/mutations", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  // Auth: no token, and a token for /mcp, are both refused.
  expect(["no token", (await post({ client_id: "c", mutations: [] })).status]).toEqual(["no token", 401]);
  const { access_token: mcpToken } = await client.connect(`${ORIGIN}/mcp`);
  expect(["/mcp token", (await post({ client_id: "c", mutations: [] }, mcpToken)).status]).toEqual(["/mcp token", 401]);

  const { access_token: token } = await client.connect(`${ORIGIN}/api/v1`);
  const batch = async (label: string, mutations: unknown[]) => {
    const res = await post({ client_id: "test-device", mutations }, token);
    expect([label, res.status]).toEqual([label, 200]);
    const out = (await res.json()) as { cursor: string; results: Result[] };
    expect([label, typeof out.cursor]).toEqual([label, "string"]);
    return out.results;
  };
  const feed = (await (await client.send("/api/v1/sync/changes?scope=all", { headers: { authorization: `Bearer ${token}` } })).json()) as {
    changes: Array<{ kind: string; id: string; data: { title?: string; name?: string } }>;
  };
  const sidOf = (title: string) => feed.changes.find((c) => c.data.title === title || c.data.name === title)!.id;
  const listSid = sidOf("One");
  const goneSid = sidOf("title T2");
  const throttledSid = sidOf("title T3");
  const taskById = async (sid: string) =>
    client.send(`/api/v1/tasks/${sid}`, { headers: { authorization: `Bearer ${token}` } });

  // A malformed batch is a 400; a malformed mutation is a per-item rejection.
  const malformed = await post("{not json", token);
  expect(["malformed JSON", malformed.status]).toEqual(["malformed JSON", 400]);
  const noArray = await post({ client_id: "c", mutations: "x" }, token);
  expect(["mutations not an array", noArray.status, await noArray.json()]).toEqual([
    "mutations not an array",
    400,
    { error: "bad_batch", detail: "mutations must be an array" },
  ]);

  const deferredBefore = opts.deferred?.() ?? 0;
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const create = {
    id: "m-create",
    at: at(60_000),
    op: "task.create",
    sid: TASK,
    fields: { list_id: listSid, title: "Call Acme", due: "2026-11-25", importance: "high" },
  };
  const [created] = await batch("create", [create]);
  expect(["create", created]).toEqual(["create", { id: "m-create", status: "applied", sid: TASK }]);
  const posted = graphCalls.find((c) => c.method === "POST" && c.url === `${G}/L1/tasks`)!;
  expect(["create body", posted.body]).toEqual([
    "create body",
    { title: "Call Acme", dueDateTime: { dateTime: "2026-11-25T00:00:00", timeZone: "UTC" }, importance: "high" },
  ]);
  const fetched = (await (await taskById(TASK)).json()) as { id: string; data: { title: string; list_id: string } };
  expect(["created task under the app's sid", fetched.id, fetched.data.title, fetched.data.list_id]).toEqual([
    "created task under the app's sid",
    TASK,
    "Call Acme",
    listSid,
  ]);
  if (opts.deferred) {
    expect(["the batch ran under waitUntil", opts.deferred() > deferredBefore]).toEqual(["the batch ran under waitUntil", true]);
  }

  // The same mutation again: the stored result, and no second Graph create.
  const [dup] = await batch("retried create", [create]);
  expect(["retried create", dup.status, graphCalls.filter((c) => c.method === "POST" && c.url === `${G}/L1/tasks`).length]).toEqual([
    "retried create",
    "duplicate",
    1,
  ]);

  // An update, translated to Graph's shapes.
  const [updated] = await batch("update", [
    {
      id: "m-update",
      at: at(40_000),
      op: "task.update",
      sid: TASK,
      fields: {
        title: "Call Acme re: renewal",
        body: { type: "text", content: "ask about Q1" },
        completed_at: "2026-11-24T23:30:00-05:00",
        reminder: { on: true, at: "2026-11-25T14:00:00Z" },
      },
    },
  ]);
  expect(["update", updated.status]).toEqual(["update", "applied"]);
  const patch = graphCalls.filter((c) => c.method === "PATCH" && c.url === `${G}/L1/tasks/GT1`).at(-1)!;
  expect(["update body", patch.body]).toEqual([
    "update body",
    {
      reminderDateTime: { dateTime: "2026-11-25T14:00:00.000", timeZone: "UTC" },
      title: "Call Acme re: renewal",
      body: { content: "ask about Q1", contentType: "text" },
      completedDateTime: { dateTime: "2026-11-25", timeZone: "UTC" },
      status: "completed",
      isReminderOn: true,
    },
  ]);

  // An older edit that sat in a queue: title is superseded and Graph isn't
  // called; a field nobody set since still applies.
  const patchesBefore = graphCalls.filter((c) => c.method === "PATCH").length;
  const [stale] = await batch("superseded update", [
    { id: "m-stale", at: at(50_000), op: "task.update", sid: TASK, fields: { title: "Older title" } },
  ]);
  expect(["superseded update", stale.status, stale.superseded_fields, graphCalls.filter((c) => c.method === "PATCH").length]).toEqual([
    "superseded update",
    "applied",
    ["title"],
    patchesBefore,
  ]);

  // A field the API can't take as given is rejected, not sent.
  const [badField] = await batch("html body", [
    { id: "m-html", at: at(1_000), op: "task.update", sid: TASK, fields: { body: { type: "html", content: "<b>x</b>" } } },
  ]);
  expect(["html body", badField.status, badField.error]).toEqual(["html body", "rejected", "invalid_field:body"]);

  // A step and a link, created then edited at once: each is addressable by
  // its sid as soon as its create is applied.
  const subs = await batch("step and link", [
    { id: "m-step", at: at(1_000), op: "step.create", sid: STEP, fields: { task_id: TASK, title: "Find contract" } },
    { id: "m-step-2", at: at(900), op: "step.update", sid: STEP, fields: { checked: true } },
    { id: "m-link", at: at(1_000), op: "link.create", sid: LINK, fields: { task_id: TASK, url: "https://acme.example/1", title: "Ticket" } },
    { id: "m-link-2", at: at(900), op: "link.update", sid: LINK, fields: { title: "Ticket 1" } },
  ]);
  for (const r of subs) expect([r.id, r.status]).toEqual([r.id, "applied"]);
  const stepPatch = graphCalls.find((c) => c.method === "PATCH" && c.url === `${G}/L1/tasks/GT1/checklistItems/S1`);
  const linkPost = graphCalls.find((c) => c.method === "POST" && c.url === `${G}/L1/tasks/GT1/linkedResources`);
  expect(["step update body", stepPatch?.body]).toEqual(["step update body", { isChecked: true }]);
  expect(["link create body", linkPost?.body]).toEqual([
    "link create body",
    { applicationName: "Microsoft To Do sync", displayName: "Ticket", webUrl: "https://acme.example/1" },
  ]);

  // My Day is off on this server.
  const [myDay] = await batch("My Day off", [{ id: "m-myday", at: at(1_000), op: "myday.add", sid: TASK }]);
  expect(["My Day off", myDay.status, myDay.error]).toEqual(["My Day off", "rejected", "my_day_disabled"]);

  // Throttled: failed with retry, and the id stays free for that retry.
  throttle = true;
  const [throttled] = await batch("429", [
    { id: "m-429", at: at(1_000), op: "task.update", sid: throttledSid, fields: { title: "x" } },
  ]);
  throttle = false;
  expect(["429", throttled]).toEqual(["429", { id: "m-429", status: "failed", error: "graph_429", retry: true }]);
  const [afterThrottle] = await batch("429 retried", [
    { id: "m-429", at: at(1_000), op: "task.update", sid: throttledSid, fields: { title: "x" } },
  ]);
  expect(["429 retried", afterThrottle.status]).toEqual(["429 retried", "applied"]);

  // One lease for the batch: an MCP write started mid-batch waits for the
  // whole batch rather than running between its Graph calls.
  let release!: () => void;
  let reached!: () => void;
  const atHold = new Promise<void>((r) => (reached = r));
  hold = { url: `${G}/L1/tasks/GT1`, until: new Promise<void>((r) => (release = r)), reached };
  const held = batch("held batch", [
    { id: "m-held", at: at(500), op: "task.update", sid: TASK, fields: { importance: "low" } },
  ]);
  await atHold;
  const graph = new GraphClient({ getAccessToken: () => index.getAccessToken(), forceRefresh: () => index.refreshToken() });
  const mcpWrite = createList(
    opsContext({ env, graph, index, substrate: async () => Promise.reject(new Error("unused")), accessToken: async () => "" }),
    { display_name: "From MCP" },
  );
  await new Promise((r) => setTimeout(r, 300));
  expect(["MCP write while the batch holds the lease", graphCalls.some((c) => c.url === G)]).toEqual([
    "MCP write while the batch holds the lease",
    false,
  ]);
  release();
  hold = null;
  const [heldResult] = await held;
  expect(["held batch", heldResult.status]).toEqual(["held batch", "applied"]);
  expect(["MCP write after the batch", (await mcpWrite).ok]).toEqual(["MCP write after the batch", true]);
  const order = graphCalls.map((c) => `${c.method} ${c.url}`);
  expect(["MCP write ran after the batch's PATCH", order.lastIndexOf(`PATCH ${G}/L1/tasks/GT1`) < order.indexOf(`POST ${G}`)]).toEqual([
    "MCP write ran after the batch's PATCH",
    true,
  ]);

  // Deletes: one Graph has, and one Graph already lost (404 counts as done).
  const deletes = await batch("deletes", [
    { id: "m-del", at: at(100), op: "task.delete", sid: TASK },
    { id: "m-del-gone", at: at(100), op: "task.delete", sid: goneSid },
  ]);
  expect(["delete", deletes[0].status]).toEqual(["delete", "applied"]);
  expect(["delete of a task Graph already lost", deletes[1].status]).toEqual(["delete of a task Graph already lost", "applied"]);
  expect(["deleted task by sid", (await taskById(TASK)).status]).toEqual(["deleted task by sid", 404]);
  expect(["lost task by sid", (await taskById(goneSid)).status]).toEqual(["lost task by sid", 404]);
  const [late] = await batch("edit after delete", [
    { id: "m-late", at: at(10), op: "task.update", sid: TASK, fields: { title: "late" } },
  ]);
  expect(["edit after delete", late.status, late.error]).toEqual(["edit after delete", "rejected", "deleted"]);
}
