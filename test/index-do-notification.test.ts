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
      // Capture inside the DO context — after the block, the armed alarm fires
      // and a normal cycle's My Day scan would add (unrelated) Substrate GETs.
      return {
        out,
        alarm: await state.storage.getAlarm(),
        substrateCalls: calls.filter((c) => c.url.includes("substrate.office.com")).length,
      };
    });
    expect(r.out.accepted).toBe(1);
    expect(r.alarm).not.toBeNull();
    expect(r.substrateCalls).toBe(0);
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
});
