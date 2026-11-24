// POST /api/v1/sync/mutations through a host's whole OAuth front, with Graph
// scripted at fetch: a real /api/v1 token, the route, applyBatch on the real
// index (the TodoIndex DO over RPC on Workers, in-process IndexCore on Node),
// the executor and the ops. Run by test/sync-mutations-route.test.ts and
// test-node/sync-mutations-route.test.ts. The env given here must have My Day
// off; the checklist cache may be on or off.
import { expect } from "vitest";
import { GraphClient } from "../src/core/graph/client";
import { opsContext } from "../src/core/ops/context";
import { WriteLease } from "../src/core/ops/write-lease";
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
const LOST = "0190a1b2-c3d4-7e5f-8a9b-000000000004";

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
  // Graph's copy of each task the checks write; the rest are as seeded. TR repeats.
  const seeded = (id: string) => graphTask(id, id === "TR" ? { recurrence: RECURRENCE } : {});
  const stored = new Map<string, Record<string, unknown>>();
  // Tasks a POST made even though its response was lost (a 502).
  const madeButLost: Array<ReturnType<typeof graphTask>> = [];
  // Source deletes that fail, per task: how many more times.
  const deleteFailures = new Map<string, number>([["TM", 99], ["TN", 1]]);
  const RECURRENCE = { pattern: { type: "daily", interval: 1 }, range: { type: "noEnd", startDate: "2026-11-01" } };
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
    if (method === "POST" && url === `${G}/L1/tasks` && body.title === "Lost response") {
      madeButLost.push(graphTask("GA", { ...body, createdDateTime: new Date().toISOString() }));
      return json({ error: { code: "BadGateway" } }, 502);
    }
    if (method === "POST" && url === `${G}/L1/tasks`) {
      stored.set("GT1", graphTask("GT1", body));
      return json(stored.get("GT1"), 201);
    }
    if (method === "POST" && url === `${G}/L2/tasks`) return json(graphTask(`C-${body.title}`, body), 201);
    // The create recovery's lookup.
    if (method === "GET" && url.startsWith(`${G}/L1/tasks?`)) return json({ value: madeButLost });
    const one = /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/todo\/lists\/L1\/tasks\/(\w+)(\?.*)?$/.exec(url);
    // Graph answers a PATCH with the whole task: what it held, plus the patch.
    if (one && method === "PATCH") {
      stored.set(one[1], { ...(stored.get(one[1]) ?? seeded(one[1])), ...body, lastModifiedDateTime: new Date().toISOString() });
      return json(stored.get(one[1]));
    }
    // The completion-date check, the link rules' re-fetch and a move's source
    // read all GET the task. TR repeats.
    if (one && method === "GET") return json(stored.get(one[1]) ?? seeded(one[1]));
    if (one && method === "DELETE" && (deleteFailures.get(one[1]) ?? 0) > 0) {
      deleteFailures.set(one[1], deleteFailures.get(one[1])! - 1);
      return json({ error: { code: "ServiceUnavailable" } }, 503);
    }
    if (one && method === "DELETE" && (one[1] === "TM" || one[1] === "TN")) return new Response(null, { status: 204 });
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
  await index.upsertList({ id: "L2", displayName: "Two" } as never);
  await index.upsertTask(graphTask("TR", { recurrence: RECURRENCE }) as never, "L1");
  await index.upsertTask(graphTask("TM") as never, "L1");
  await index.upsertTask(graphTask("TN") as never, "L1");
  // Completed at 23:30 in New York on the 24th: 04:30 UTC on the 25th.
  await index.upsertTask(
    graphTask("TL", { status: "completed", completedDateTime: { dateTime: "2026-11-25T04:30:00.0000000", timeZone: "UTC" } }) as never,
    "L1",
  );

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
  const list2Sid = sidOf("Two");
  const taskSid = Object.fromEntries(["TR", "TM", "TN", "TL"].map((id) => [id, sidOf(`title ${id}`)]));
  const todayNY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
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
  const fetched = (await (await taskById(TASK)).json()) as {
    id: string;
    data: { title: string; list_id: string; subresources_complete: boolean };
  };
  // A task the create just made has no sub-resources to wait for.
  expect(["new task's sub-resources known", fetched.data.subresources_complete]).toEqual(["new task's sub-resources known", true]);
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
        // Completed on an earlier day: a backdate.
        completed_at: "2026-11-20",
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
      completedDateTime: { dateTime: "2026-11-20", timeZone: "UTC" },
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
    { applicationName: "Microsoft To Do sync", displayName: "Ticket", externalId: LINK, webUrl: "https://acme.example/1" },
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
  // The MCP writer's lease port reports when it asks for the lease, so the
  // check below runs once the writer is waiting on it, not after a sleep.
  let asked!: () => void;
  const askedForLease = new Promise<void>((r) => (asked = r));
  const writes = new WriteLease({
    acquireWriteLease: (...a) => (asked(), index.acquireWriteLease(...a)),
    releaseWriteLease: (...a) => index.releaseWriteLease(...a),
  });
  const graph = new GraphClient({ getAccessToken: () => index.getAccessToken(), forceRefresh: () => index.refreshToken() });
  const mcpWrite = createList(
    opsContext({ env, graph, index, substrate: async () => Promise.reject(new Error("unused")), accessToken: async () => "", writes }),
    { display_name: "From MCP" },
  );
  await askedForLease;
  expect(["MCP write while the batch holds the lease", graphCalls.some((c) => c.url === G)]).toEqual([
    "MCP write while the batch holds the lease",
    false,
  ]);
  const releasedAt = graphCalls.length;
  release();
  hold = null;
  const [heldResult] = await held;
  expect(["held batch", heldResult.status]).toEqual(["held batch", "applied"]);
  expect(["MCP write after the batch", (await mcpWrite).ok]).toEqual(["MCP write after the batch", true]);
  expect(["MCP write ran after the batch released", graphCalls.findIndex((c) => c.method === "POST" && c.url === G) >= releasedAt]).toEqual([
    "MCP write ran after the batch released",
    true,
  ]);

  // Completion is a bare date in the owner's calendar, both ways: a task
  // completed at 23:30 in New York reads as that day, not the UTC one.
  const lateEvening = (await (await taskById(taskSid.TL)).json()) as { data: { completed_at: string } };
  expect(["completion late in the owner's evening", lateEvening.data.completed_at]).toEqual([
    "completion late in the owner's evening",
    "2026-11-24",
  ]);

  // A repeating task: completing it today sends the status alone (no date it
  // can't hold); a backdated completion is refused by the op and sent again
  // as a plain completion.
  const trPatches = () => graphCalls.filter((c) => c.method === "PATCH" && c.url === `${G}/L1/tasks/TR`);
  const [doneToday] = await batch("recurring completed today", [
    { id: "m-rec-today", at: at(30), op: "task.update", sid: taskSid.TR, fields: { status: "completed", completed_at: todayNY } },
  ]);
  expect(["recurring completed today", doneToday.status, trPatches().map((c) => c.body)]).toEqual([
    "recurring completed today",
    "applied",
    [{ status: "completed" }],
  ]);
  const [doneEarlier] = await batch("recurring completed earlier", [
    { id: "m-rec-back", at: at(20), op: "task.update", sid: taskSid.TR, fields: { completed_at: "2026-11-01" } },
  ]);
  expect(["recurring completed earlier", doneEarlier.status, trPatches().at(-1)?.body]).toEqual([
    "recurring completed earlier",
    "applied",
    { status: "completed" },
  ]);

  // A create whose response was lost (502) is failed and retried; the retry
  // finds the task the first attempt made and adopts it instead of posting
  // a second.
  const lost = { id: "m-lost", at: at(15), op: "task.create", sid: LOST, fields: { list_id: listSid, title: "Lost response" } };
  const [lostFirst] = await batch("create, response lost", [lost]);
  expect(["create, response lost", lostFirst.status, lostFirst.retry]).toEqual(["create, response lost", "failed", true]);
  const [lostRetry] = await batch("create retried after a lost response", [lost]);
  const lostPosts = graphCalls.filter((c) => c.method === "POST" && c.url === `${G}/L1/tasks` && (c.body as { title?: string }).title === "Lost response");
  expect(["create retried after a lost response", lostRetry.status, lostPosts.length]).toEqual([
    "create retried after a lost response",
    "applied",
    1,
  ]);
  const adopted = (await (await taskById(LOST)).json()) as { data: { title: string } };
  expect(["adopted task under the app's sid", adopted.data.title]).toEqual(["adopted task under the app's sid", "Lost response"]);

  // A copy-and-delete move (My Day is off) whose source delete fails: the
  // app's sid goes to the copy either way. TN's delete succeeds on the retry;
  // TM's never does, so TM comes back as a task of its own.
  const moves = await batch("moves with a failing source delete", [
    { id: "m-move-n", at: at(10), op: "task.move", sid: taskSid.TN, fields: { list_id: list2Sid } },
    { id: "m-move-m", at: at(10), op: "task.move", sid: taskSid.TM, fields: { list_id: list2Sid } },
  ]);
  for (const r of moves) expect([r.id, r.status]).toEqual([r.id, "applied"]);
  for (const id of ["TN", "TM"]) {
    const moved = (await (await taskById(taskSid[id])).json()) as { data: { list_id: string } };
    expect([`${id}: the app's sid is in the destination`, moved.data.list_id]).toEqual([`${id}: the app's sid is in the destination`, list2Sid]);
  }
  const after = (await (await client.send("/api/v1/sync/changes?scope=all", { headers: { authorization: `Bearer ${token}` } })).json()) as {
    changes: Array<{ id: string; deleted?: boolean; data?: { title?: string; list_id?: string } }>;
  };
  const liveTitled = (title: string) => after.changes.filter((c) => !c.deleted && c.data?.title === title);
  expect(["TN: one task left", liveTitled("title TN").map((c) => c.data!.list_id)]).toEqual(["TN: one task left", [list2Sid]]);
  expect(["TM: the source left behind shows as its own task", liveTitled("title TM").map((c) => c.data!.list_id).sort()]).toEqual([
    "TM: the source left behind shows as its own task",
    [listSid, list2Sid].sort(),
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
