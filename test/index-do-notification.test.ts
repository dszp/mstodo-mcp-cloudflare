import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { TodoIndex } from "../src/cache/index-do";
import { SCOPES, TOKENS_KEY, IDENTITY_KEY } from "../src/auth/microsoft";

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
  await env.TODO_CACHE.put(
    IDENTITY_KEY,
    JSON.stringify({
      id: "oid",
      displayName: "Owner",
      mail: "owner@example.com",
      userPrincipalName: "owner@example.com",
      first_seen: Date.now(),
      last_seen: Date.now(),
      anchorMailbox: "OID:oid@tid",
    }),
  );
}
const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  await env.TODO_CACHE.delete(TOKENS_KEY);
  await env.TODO_CACHE.delete(IDENTITY_KEY);
});

// Substrate GET returns the supplied task; a token mint POSTs to the login host
// (fulfilled so getSubstrateAccessToken works). Records method per call so we
// can prove the path issues no MUTATING Substrate calls.
function installSubstrate(task: Record<string, unknown>) {
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.includes("substrate.office.com") && method === "GET")
      return Response.json(task, { status: 200 });
    if (url.includes("login.microsoftonline.com"))
      return Response.json(
        { access_token: "EXO", expires_in: 3600, token_type: "Bearer", scope: "x" },
        { status: 200 },
      );
    return new Response(`unscripted ${method} ${url}`, { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

const sub = (id: string, listId: string, clientState: string) => ({
  subscription_id: id,
  list_id: listId,
  client_state: clientState,
  expiration_ms: Date.now() + 3_600_000,
  created_at_ms: Date.now(),
});

describe("onChangeNotification", () => {
  it("refreshes the one task's My Day fields (targeted GET), arms the alarm, makes NO mutating calls", async () => {
    await signIn();
    const stub = indexStub("notif-1");
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    await stub.upsertTask(
      { id: "T1", title: "t", status: "notStarted", lastModifiedDateTime: "2026-05-02T00:00:00Z" },
      "L1",
    );
    await stub.putSubscription(sub("SUB1", "L1", "good"));

    const calls = installSubstrate({ Id: "T1", CommittedDay: "2026-05-29T00:00:00Z", CommittedOrder: "0001" });
    // Read state in the same DO context so the alarm can't fire mid-assertion.
    const r = await runInDurableObject(stub, async (inst: TodoIndex, state) => {
      const out = await inst.onChangeNotification([
        { subscriptionId: "SUB1", clientState: "good", changeType: "updated", resourceId: "T1" },
      ]);
      return { out, md: inst.getMyDayFields("T1"), alarm: await state.storage.getAlarm() };
    });

    expect(r.out.accepted).toBe(1);
    expect(r.md?.committed_day).toBe("2026-05-29");
    expect(r.md?.committed_order).toBe("0001");
    expect(r.alarm).not.toBeNull();
    // Read-only: every Substrate call was a GET (no PATCH/POST/DELETE).
    const mutating = calls.filter((c) => c.url.includes("substrate.office.com") && c.method !== "GET");
    expect(mutating).toHaveLength(0);
  });

  it("for a task not yet cached, marks the list scan-due instead (no lost fields)", async () => {
    await signIn();
    const stub = indexStub("notif-1b");
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    await stub.putSubscription(sub("SUB1", "L1", "good"));
    installSubstrate({ Id: "NEW", CommittedDay: "2026-05-29T00:00:00Z" });

    const rows = await runInDurableObject(stub, async (inst: TodoIndex, state) => {
      await inst.onChangeNotification([
        { subscriptionId: "SUB1", clientState: "good", changeType: "created", resourceId: "NEW" },
      ]);
      return state.storage.sql
        .exec("SELECT last_synced_at FROM sync_state WHERE resource = ?", "myday:L1")
        .toArray();
    });
    expect(rows).toHaveLength(1);
    expect((rows[0] as { last_synced_at: number | null }).last_synced_at).toBeNull();
  });

  it("skips the Substrate call for a deleted task but still arms the alarm", async () => {
    await signIn();
    const stub = indexStub("notif-1c");
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    await stub.putSubscription(sub("SUB1", "L1", "good"));
    const calls = installSubstrate({ Id: "x" });

    const r = await runInDurableObject(stub, async (inst: TodoIndex, state) => {
      const out = await inst.onChangeNotification([
        { subscriptionId: "SUB1", clientState: "good", changeType: "deleted", resourceId: "T1" },
      ]);
      // Count only TARGETED single-task getTask calls (.../tasks/{id}), which is
      // the call this path would make for a non-deleted task. The My Day scan's
      // listFolderTasks hits the collection (.../tasks, no trailing /{id}) — so a
      // foreign DO instance's armed alarm firing into the shared global fetch spy
      // mid-block can't pollute this assertion (it was a real cross-test flake).
      return {
        out,
        alarm: await state.storage.getAlarm(),
        getTaskCalls: calls.filter(
          (c) => c.url.includes("substrate.office.com") && c.url.includes("/tasks/"),
        ).length,
      };
    });
    expect(r.out.accepted).toBe(1);
    expect(r.alarm).not.toBeNull();
    expect(r.getTaskCalls).toBe(0);
  });

  it("rejects a clientState mismatch and does nothing", async () => {
    const stub = indexStub("notif-2");
    await stub.putSubscription(sub("SUB1", "L1", "good"));
    const out = await stub.onChangeNotification([
      { subscriptionId: "SUB1", clientState: "WRONG", resourceId: "T1" },
    ]);
    expect(out.accepted).toBe(0);
    expect(out.rejected).toBe(1);
  });

  it("ignores notifications for an unknown subscriptionId", async () => {
    const stub = indexStub("notif-3");
    const out = await stub.onChangeNotification([
      { subscriptionId: "ghost", clientState: "x", resourceId: "T1" },
    ]);
    expect(out.accepted).toBe(0);
    expect(out.rejected).toBe(1);
  });

  it("onLifecycleEvent reauthorizationRequired renews (PATCHes) the subscription", async () => {
    await signIn();
    const stub = indexStub("notif-life-1");
    const now = Date.now();
    await stub.putSubscription({
      subscription_id: "SUB1", list_id: "L1", client_state: "good",
      expiration_ms: now + 60_000, created_at_ms: now,
    });
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "PATCH" && url.includes("/subscriptions/SUB1"))
        return Response.json(
          { id: "SUB1", expirationDateTime: new Date(now + 70 * 60 * 60_000).toISOString() },
          { status: 200 },
        );
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const out = await stub.onLifecycleEvent([
      { subscriptionId: "SUB1", clientState: "good", lifecycleEvent: "reauthorizationRequired" },
    ]);
    expect(out.reauthorized).toBe(1);
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/subscriptions/SUB1"))).toBe(true);
    // The reauthorize PATCH advanced expiry well past the 12h renew margin.
    expect((await stub.findSubscription("SUB1"))!.expiration_ms).toBeGreaterThan(now + 12 * 60 * 60_000);
  });

  it("onLifecycleEvent subscriptionRemoved drops the record (reconcile recreates)", async () => {
    await signIn();
    const stub = indexStub("notif-life-2");
    const now = Date.now();
    await stub.putSubscription({
      subscription_id: "SUB1", list_id: "L1", client_state: "good",
      expiration_ms: now + 60_000, created_at_ms: now,
    });
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const out = await stub.onLifecycleEvent([
      { subscriptionId: "SUB1", clientState: "good", lifecycleEvent: "subscriptionRemoved" },
    ]);
    expect(out.removed).toBe(1);
    expect(await stub.findSubscription("SUB1")).toBeNull();
  });

  it("onLifecycleEvent rejects a clientState mismatch and does not reauthorize", async () => {
    const stub = indexStub("notif-life-3");
    const now = Date.now();
    await stub.putSubscription({
      subscription_id: "SUB1", list_id: "L1", client_state: "good",
      expiration_ms: now + 60_000, created_at_ms: now,
    });
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const out = await stub.onLifecycleEvent([
      { subscriptionId: "SUB1", clientState: "WRONG", lifecycleEvent: "reauthorizationRequired" },
    ]);
    // reauthorized:0 proves no PATCH was issued (a reauthorize requires one);
    // rejected:1 + the untouched record prove the mismatch was a no-op.
    expect(out.rejected).toBe(1);
    expect(out.reauthorized).toBe(0);
    expect((await stub.findSubscription("SUB1"))!.expiration_ms).toBe(now + 60_000);
  });

  it("stamps webhook delivery health on accepted notifications, never on rejected ones", async () => {
    await signIn();
    const stub = indexStub("notif-health");
    // List in the roster + far-future expiry so the subscription survives any
    // reconcile/renew cycle a firing alarm runs between the two accepts (an
    // unrostered or near-expiry sub would be torn down under the 404 stub).
    await stub.upsertList({ id: "L1", displayName: "L1", isOwner: true, isShared: false });
    await stub.putSubscription({
      subscription_id: "SUB1",
      list_id: "L1",
      client_state: "good",
      expiration_ms: Date.now() + 100 * 60 * 60_000,
      created_at_ms: Date.now(),
    });
    // Uncached task ⇒ the My Day branch marks scan-due and issues no Substrate
    // call; 404-stub fetch is just insurance against accidental real network.
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;

    const before = await stub.syncStatus();
    expect(before.notifications.last_notification_at).toBeNull();
    expect(before.notifications.notifications_total).toBe(0);
    expect(before.notifications.minutes_since).toBeNull();

    // A rejected notification (bad clientState) must NOT stamp health — the
    // public /webhook cannot be used to forge a "delivering" signal.
    await stub.onChangeNotification([
      { subscriptionId: "SUB1", clientState: "WRONG", changeType: "updated", resourceId: "T1" },
    ]);
    const afterReject = await stub.syncStatus();
    expect(afterReject.notifications.last_notification_at).toBeNull();
    expect(afterReject.notifications.notifications_total).toBe(0);

    // An accepted notification stamps last_notification_at and the total.
    const out = await stub.onChangeNotification([
      { subscriptionId: "SUB1", clientState: "good", changeType: "updated", resourceId: "T1" },
    ]);
    expect(out.accepted).toBe(1);
    const afterAccept = await stub.syncStatus();
    expect(afterAccept.notifications.last_notification_at).not.toBeNull();
    expect(afterAccept.notifications.notifications_total).toBe(1);
    expect(afterAccept.notifications.minutes_since).toBeGreaterThanOrEqual(0);

    // A second accepted batch accumulates the cumulative total.
    await stub.onChangeNotification([
      { subscriptionId: "SUB1", clientState: "good", changeType: "updated", resourceId: "T2" },
    ]);
    expect((await stub.syncStatus()).notifications.notifications_total).toBe(2);
  });
});
