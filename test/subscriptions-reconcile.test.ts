import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { TodoIndex } from "../src/cache/index-do";
import { SCOPES, TOKENS_KEY } from "../src/auth/microsoft";
import { parseTodoListId } from "../src/subscriptions/manager";

function indexStub(name: string) {
  return env.TODO_INDEX_DO.getByName(name);
}
async function signIn() {
  await env.TODO_CACHE.put(
    TOKENS_KEY,
    JSON.stringify({
      access_token: "AT",
      refresh_token: "RT",
      expires_at: Date.now() + 3_600_000,
      scope: SCOPES,
      obtained_at: Date.now(),
    }),
  );
}
const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  await env.TODO_CACHE.delete(TOKENS_KEY);
});

// Stateful Graph fake: GET /subscriptions reflects what POST created (and DELETE
// removed), so the reconciler's Graph cross-check sees a faithful roster.
//
// Options model the roster-fetch edge cases the cross-check has to survive:
//   pageSize    — paginate the roster via @odata.nextLink (?skip=N), so we can
//                 prove the follower reassembles a multi-page roster without
//                 misclassifying live subs as dead.
//   infinite    — every roster page returns a nextLink (never terminates), so
//                 listGraphSubscriptions trips its page cap and throws.
// Controls returned: dropFromGraph(id) simulates Graph expiring a sub out from
// under us; seedGraphSub(sub) injects an untracked sub already on Graph;
// setFailList(v) makes the roster GET 500 (unreachable Graph).
function installGraph(opts: { pageSize?: number; infinite?: boolean } = {}) {
  const calls: { url: string; method: string; body: any }[] = [];
  const subs = new Map<string, any>();
  let n = 0;
  let failList = false;
  const idFromUrl = (url: string) => {
    const m = url.match(/subscriptions\/([^/?]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const isCollection = (url: string) => /\/subscriptions(\?|$)/.test(url);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, method, body });
    if (method === "GET" && isCollection(url)) {
      if (failList) return new Response("boom", { status: 500 });
      const all = [...subs.values()];
      const size = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : all.length || 1;
      const skip = Number(url.match(/[?&]skip=(\d+)/)?.[1] ?? 0);
      const page = all.slice(skip, skip + size);
      const payload: any = { value: page };
      if (opts.infinite || skip + size < all.length)
        payload["@odata.nextLink"] = `https://graph.microsoft.com/v1.0/subscriptions?skip=${skip + size}`;
      return Response.json(payload, { status: 200 });
    }
    if (url.endsWith("/subscriptions") && method === "POST") {
      const id = `SUB${++n}`;
      subs.set(id, {
        id,
        resource: body.resource,
        notificationUrl: body.notificationUrl,
        clientState: body.clientState,
        expirationDateTime: body.expirationDateTime,
      });
      return Response.json(
        { id, resource: body.resource, expirationDateTime: body.expirationDateTime },
        { status: 201 },
      );
    }
    if (method === "DELETE") {
      const id = idFromUrl(url);
      if (id) subs.delete(id);
      return new Response("", { status: 204 });
    }
    if (method === "PATCH") {
      const id = idFromUrl(url) ?? "x";
      const existing = subs.get(id);
      if (existing) existing.expirationDateTime = body.expirationDateTime;
      return Response.json({ id, expirationDateTime: body.expirationDateTime }, { status: 200 });
    }
    return new Response(`unscripted ${method} ${url}`, { status: 404 });
  }) as unknown as typeof fetch;
  return {
    calls,
    dropFromGraph: (id: string) => subs.delete(id),
    seedGraphSub: (sub: any) => subs.set(sub.id, sub),
    setFailList: (v: boolean) => {
      failList = v;
    },
  };
}

describe("reconcileSubscriptions", () => {
  it("creates at most MAX_SUBSCRIPTION_OPS_PER_CYCLE subscriptions per call", async () => {
    await signIn();
    const stub = indexStub("recon-1");
    for (const id of ["L1", "L2", "L3", "L4", "L5"]) {
      await stub.upsertList({ id, displayName: id, isOwner: true, isShared: false });
    }
    const { calls } = installGraph();
    await stub.reconcileSubscriptions();
    const created = calls.filter((c) => c.method === "POST").length;
    expect(created).toBe(2); // MAX_SUBSCRIPTION_OPS_PER_CYCLE (free-tier default)
    expect((await stub.getSubscriptions()).length).toBe(2);

    // Coverage fills in over subsequent cycles (5 lists ÷ 2 per cycle = 3 cycles).
    await stub.reconcileSubscriptions();
    await stub.reconcileSubscriptions();
    expect((await stub.getSubscriptions()).length).toBe(5);
  });

  it("creates subscriptions with a lifecycleNotificationUrl on the same /webhook endpoint", async () => {
    await signIn();
    const stub = indexStub("recon-lifecycle");
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    const { calls } = installGraph();
    await stub.reconcileSubscriptions();
    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeTruthy();
    // The field that keeps an Exchange-backed todoTask sub from going dormant.
    expect(post!.body.lifecycleNotificationUrl).toBeTruthy();
    expect(post!.body.lifecycleNotificationUrl).toBe(post!.body.notificationUrl);
  });

  it("recreateSubscriptions clears records (one list, then all) and arms the alarm", async () => {
    const stub = indexStub("recon-recreate");
    // Seed records directly and read back synchronously inside the DO so a
    // freshly-armed alarm can't run reconcile and re-mint between assertions.
    await runInDurableObject(stub, async (inst: TodoIndex) => {
      const now = 1_700_000_000_000;
      inst.putSubscription({
        subscription_id: "S1", list_id: "L1", client_state: "cs", expiration_ms: now, created_at_ms: now,
      });
      inst.putSubscription({
        subscription_id: "S2", list_id: "L2", client_state: "cs", expiration_ms: now, created_at_ms: now,
      });
      expect((await inst.recreateSubscriptions("L1")).cleared).toBe(1);
      expect(inst.getSubscriptions().map((r) => r.list_id)).toEqual(["L2"]);
      expect((await inst.recreateSubscriptions()).cleared).toBe(1);
      expect(inst.getSubscriptions()).toHaveLength(0);
    });
  });

  it("deletes a record (and the Graph sub) when its list is gone", async () => {
    await signIn();
    const stub = indexStub("recon-2");
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    const { calls } = installGraph();
    await stub.reconcileSubscriptions();
    expect((await stub.getSubscriptions()).length).toBe(1);

    await stub.deleteList("L1");
    await stub.reconcileSubscriptions();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect((await stub.getSubscriptions()).length).toBe(0);
  });

  it("when the gate is OFF, creates nothing and tears existing subs down", async () => {
    await signIn();
    const off = indexStub("recon-3");
    await off.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    installGraph();
    await off.reconcileSubscriptions(); // gate ON (default) -> creates
    expect((await off.getSubscriptions()).length).toBe(1);

    const { calls } = installGraph();
    await off.reconcileSubscriptions({ enabled: false });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect((await off.getSubscriptions()).length).toBe(0);
  });

  it("resetIdentity deletes the Graph subscriptions before wiping records", async () => {
    await signIn();
    const stub = indexStub("recon-reset");
    const now = Date.now();
    await stub.putSubscription({
      subscription_id: "S1", list_id: "L1", client_state: "cs", expiration_ms: now + 3_600_000, created_at_ms: now,
    });
    await stub.putSubscription({
      subscription_id: "S2", list_id: "L2", client_state: "cs", expiration_ms: now + 3_600_000, created_at_ms: now,
    });
    const { calls } = installGraph();
    await stub.resetIdentity();
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deletes.some((u) => u.includes("/subscriptions/S1"))).toBe(true);
    expect(deletes.some((u) => u.includes("/subscriptions/S2"))).toBe(true);
    expect(await stub.getSubscriptions()).toEqual([]);
  });

  it("renewSubscriptions PATCHes only records within the renew margin", async () => {
    await signIn();
    const stub = indexStub("recon-4");
    const now = Date.now();
    // One expiring soon (within 12h), one fresh (well beyond).
    await stub.putSubscription({
      subscription_id: "SOON", list_id: "L1", client_state: "cs",
      expiration_ms: now + 60_000, created_at_ms: now,
    });
    await stub.putSubscription({
      subscription_id: "FRESH", list_id: "L2", client_state: "cs",
      expiration_ms: now + 60 * 60 * 60_000, created_at_ms: now,
    });
    const { calls } = installGraph();
    await stub.renewSubscriptions();
    const patched = calls.filter((c) => c.method === "PATCH");
    expect(patched).toHaveLength(1);
    expect(patched[0].url).toContain("/subscriptions/SOON");
    // The renewed record's expiry advanced well past the margin.
    const soon = await stub.findSubscription("SOON");
    expect(soon!.expiration_ms).toBeGreaterThan(now + 12 * 60 * 60_000);
  });

  it("recreates a record whose Graph subscription vanished (silent drift)", async () => {
    await signIn();
    const stub = indexStub("recon-drift");
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    const { calls, dropFromGraph } = installGraph();
    await stub.reconcileSubscriptions();
    const before = await stub.getSubscriptions();
    expect(before).toHaveLength(1);

    // Graph expires/evicts the subscription out from under us; the local record
    // still looks healthy. Old behaviour: never noticed (record present). New:
    // the cross-check drops the dead record and recreates a fresh sub same cycle.
    dropFromGraph(before[0].subscription_id);
    await stub.reconcileSubscriptions();

    const after = await stub.getSubscriptions();
    expect(after).toHaveLength(1); // still covered
    expect(after[0].subscription_id).not.toBe(before[0].subscription_id); // fresh sub
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2); // initial + recreate
  });

  it("subscription_status reports config and classifies drift", async () => {
    await signIn();
    const stub = indexStub("recon-status");
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    const { dropFromGraph } = installGraph();
    await stub.reconcileSubscriptions();

    const healthy = await stub.subscriptionStatus();
    expect(healthy.ok).toBe(true);
    expect(healthy.config.subscriptions_enabled).toBe(true);
    expect(healthy.config.max_subscription_ops_per_cycle).toBeGreaterThanOrEqual(1);
    expect(healthy.summary.dark).toBe(0);
    expect(healthy.summary.dead).toBe(0);
    expect(healthy.summary.orphan).toBe(0);

    // After Graph drops the sub, status sees the local record as dead and the
    // list as dark (no live Graph sub), without mutating anything.
    const recs = await stub.getSubscriptions();
    dropFromGraph(recs[0].subscription_id);
    const drifted = await stub.subscriptionStatus();
    expect(drifted.summary.dead).toBe(1);
    expect(drifted.dead[0].list_id).toBe("L1");
    expect(drifted.summary.dark).toBe(1);
    expect((await stub.getSubscriptions()).length).toBe(1); // read-only: record untouched
  });

  it("reassembles a paginated Graph roster without misclassifying live subs", async () => {
    await signIn();
    const stub = indexStub("recon-paged");
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    await stub.upsertList({ id: "L2", displayName: "L2", isOwner: true, isShared: false });
    const { calls } = installGraph({ pageSize: 1 }); // one sub per roster page
    await stub.reconcileSubscriptions(); // creates SUB1, SUB2 (budget 2)
    const before = await stub.getSubscriptions();
    expect(before).toHaveLength(2);

    // Second cycle: the roster now spans two pages. If the follower stopped at
    // page 1, SUB2 would read as dead → dropped + recreated (churn). It must not.
    await stub.reconcileSubscriptions();
    const after = await stub.getSubscriptions();
    expect(after.map((r) => r.subscription_id).sort()).toEqual(
      before.map((r) => r.subscription_id).sort(),
    ); // same ids, no churn
    expect(calls.some((c) => c.method === "GET" && /skip=1/.test(c.url))).toBe(true); // page 2 fetched
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2); // no recreate
    expect(calls.some((c) => c.method === "DELETE")).toBe(false); // no teardown
  });

  it("falls back to record-only when the roster paginates without end", async () => {
    await signIn();
    const stub = indexStub("recon-infinite");
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    installGraph();
    await stub.reconcileSubscriptions(); // create the sub for L1
    const before = await stub.getSubscriptions();
    expect(before).toHaveLength(1);

    // Graph's roster now paginates forever: the page cap throws, so the
    // cross-check is skipped and the record is PRESERVED rather than churned —
    // "never act on a roster we can't prove complete". (The fresh fake's roster
    // is empty, so without the guard the record would read as dead and recreate.)
    const { calls } = installGraph({ infinite: true });
    await stub.reconcileSubscriptions();
    const after = await stub.getSubscriptions();
    expect(after).toHaveLength(1);
    expect(after[0].subscription_id).toBe(before[0].subscription_id); // untouched
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("preserves records when the Graph roster fetch fails (never drops what it can't disprove)", async () => {
    await signIn();
    const stub = indexStub("recon-listfail");
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    const ctl = installGraph();
    await stub.reconcileSubscriptions();
    const before = await stub.getSubscriptions();
    expect(before).toHaveLength(1);

    // Graph really did drop the sub, but the roster GET is now unreachable (500).
    // The cross-check can't run, so it must NOT drop the record on suspicion.
    ctl.dropFromGraph(before[0].subscription_id);
    ctl.setFailList(true);
    await stub.reconcileSubscriptions();
    const after = await stub.getSubscriptions();
    expect(after).toHaveLength(1);
    expect(after[0].subscription_id).toBe(before[0].subscription_id); // untouched
  });

  it("tears down an untracked Graph sub on our webhook URL (orphan)", async () => {
    await signIn();
    const stub = indexStub("recon-orphan");
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    const ctl = installGraph();
    await stub.reconcileSubscriptions(); // creates a tracked sub on L1
    const notifUrl = ctl.calls.find((c) => c.method === "POST")!.body.notificationUrl;

    // An extra Graph sub on OUR webhook URL that no local record tracks (e.g. a
    // create whose record write was lost). It can't be adopted — Graph's GET
    // omits clientState — so reconcile tears it down to reclaim tenant quota.
    ctl.seedGraphSub({
      id: "ORPHAN1",
      resource: "/me/todo/lists/L1/tasks",
      notificationUrl: notifUrl,
      expirationDateTime: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await stub.reconcileSubscriptions();
    expect(
      ctl.calls.some((c) => c.method === "DELETE" && /\/subscriptions\/ORPHAN1/.test(c.url)),
    ).toBe(true);
    expect((await stub.getSubscriptions()).map((r) => r.list_id)).toContain("L1"); // tracked sub kept
  });
});

describe("parseTodoListId", () => {
  it("extracts the list id from a todoTask tasks resource (leading slash optional)", () => {
    expect(parseTodoListId("/me/todo/lists/AQMk123/tasks")).toBe("AQMk123");
    expect(parseTodoListId("me/todo/lists/AQMk123/tasks")).toBe("AQMk123");
  });
  it("returns null for non-todoTask resources and empty input", () => {
    expect(parseTodoListId(undefined)).toBeNull();
    expect(parseTodoListId("/me/messages")).toBeNull();
  });
  it("does not throw on a malformed %-escape — falls back to the raw capture", () => {
    expect(parseTodoListId("/me/todo/lists/bad%ZZ/tasks")).toBe("bad%ZZ");
  });
  it("decodes a percent-encoded list id", () => {
    expect(parseTodoListId("/me/todo/lists/a%2Fb/tasks")).toBe("a/b");
  });
});
