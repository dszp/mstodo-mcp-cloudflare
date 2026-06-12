import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { SCOPES, TOKENS_KEY } from "../src/auth/microsoft";

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
// removed), so the reconciler's Graph cross-check sees a faithful roster. Returns
// the recorded `calls` plus `dropFromGraph(id)` to simulate Graph expiring/evicting
// a subscription out from under us (without touching our local record).
function installGraph() {
  const calls: { url: string; method: string; body: any }[] = [];
  const subs = new Map<string, any>();
  let n = 0;
  const idFromUrl = (url: string) => {
    const m = url.match(/subscriptions\/([^/?]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, method, body });
    if (url.endsWith("/subscriptions") && method === "GET")
      return Response.json({ value: [...subs.values()] }, { status: 200 });
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
  return { calls, dropFromGraph: (id: string) => subs.delete(id) };
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
});
