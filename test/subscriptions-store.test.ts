import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function indexStub(name: string) {
  return env.TODO_INDEX_DO.getByName(name);
}

const rec = (id: string, listId: string, exp: number) => ({
  subscription_id: id,
  list_id: listId,
  client_state: `cs-${id}`,
  expiration_ms: exp,
  created_at_ms: 1_000,
});

describe("subscriptions table migration", () => {
  it("exposes an empty subscription list on a fresh DO (table exists)", async () => {
    const stub = indexStub("subs-migration-1");
    expect(await stub.getSubscriptions()).toEqual([]);
  });
});

describe("TodoIndex subscription store", () => {
  it("starts empty, then upserts and lists records", async () => {
    const stub = indexStub("subs-store-1");
    expect(await stub.getSubscriptions()).toEqual([]);
    await stub.putSubscription(rec("S1", "L1", 5_000));
    await stub.putSubscription(rec("S2", "L2", 6_000));
    const all = await stub.getSubscriptions();
    expect(all.map((r) => r.subscription_id).sort()).toEqual(["S1", "S2"]);
  });

  it("putSubscription is idempotent on subscription_id", async () => {
    const stub = indexStub("subs-store-2");
    await stub.putSubscription(rec("S1", "L1", 5_000));
    await stub.putSubscription({ ...rec("S1", "L1", 9_999), client_state: "cs-new" });
    const all = await stub.getSubscriptions();
    expect(all).toHaveLength(1);
    expect(all[0].expiration_ms).toBe(9_999);
    expect(all[0].client_state).toBe("cs-new");
  });

  it("findSubscription resolves by id; deleteSubscriptionRecord removes it", async () => {
    const stub = indexStub("subs-store-3");
    await stub.putSubscription(rec("S1", "L1", 5_000));
    expect((await stub.findSubscription("S1"))?.list_id).toBe("L1");
    await stub.deleteSubscriptionRecord("S1");
    expect(await stub.findSubscription("S1")).toBeNull();
  });
});
