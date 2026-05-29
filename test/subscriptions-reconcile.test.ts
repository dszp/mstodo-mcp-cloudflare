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

// Router: GET /subscriptions -> []; POST -> 201 with a generated id; DELETE/PATCH ok.
function installGraph() {
  const calls: { url: string; method: string; body: any }[] = [];
  let n = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, method, body });
    if (url.endsWith("/subscriptions") && method === "GET")
      return Response.json({ value: [] }, { status: 200 });
    if (url.endsWith("/subscriptions") && method === "POST")
      return Response.json(
        { id: `SUB${++n}`, resource: body.resource, expirationDateTime: body.expirationDateTime },
        { status: 201 },
      );
    if (method === "DELETE") return new Response("", { status: 204 });
    if (method === "PATCH")
      return Response.json({ id: "x", expirationDateTime: body.expirationDateTime }, { status: 200 });
    return new Response(`unscripted ${method} ${url}`, { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

describe("reconcileSubscriptions", () => {
  it("creates at most MAX_SUBSCRIPTION_OPS_PER_CYCLE subscriptions per call", async () => {
    await signIn();
    const stub = indexStub("recon-1");
    for (const id of ["L1", "L2", "L3", "L4", "L5"]) {
      await stub.upsertList({ id, displayName: id, isOwner: true, isShared: false });
    }
    const calls = installGraph();
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
    installGraph();
    await stub.reconcileSubscriptions();
    expect((await stub.getSubscriptions()).length).toBe(1);

    await stub.deleteList("L1");
    const calls = installGraph();
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

    const calls = installGraph();
    await off.reconcileSubscriptions({ enabled: false });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect((await off.getSubscriptions()).length).toBe(0);
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
    const calls = installGraph();
    await stub.renewSubscriptions();
    const patched = calls.filter((c) => c.method === "PATCH");
    expect(patched).toHaveLength(1);
    expect(patched[0].url).toContain("/subscriptions/SOON");
    // The renewed record's expiry advanced well past the margin.
    const soon = await stub.findSubscription("SOON");
    expect(soon!.expiration_ms).toBeGreaterThan(now + 12 * 60 * 60_000);
  });
});
