import { describe, it, expect, vi, afterEach } from "vitest";
import { GraphClient, type TokenProvider } from "../src/graph/client";
import {
  newClientState,
  createSubscription,
  renewSubscription,
  deleteSubscription,
  listGraphSubscriptions,
  desiredExpiration,
} from "../src/subscriptions/manager";

const tp: TokenProvider = {
  getAccessToken: async () => "AT",
  forceRefresh: async () => "AT2",
};
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

type Call = { url: string; method: string; body: string | null };
function install(handler: (c: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: (init?.body as string) ?? null,
    };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  return calls;
}

describe("newClientState", () => {
  it("is a long, URL-safe, unguessable string under Graph's 128-char cap", () => {
    const a = newClientState();
    const b = newClientState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("createSubscription", () => {
  it("POSTs to graph /subscriptions with the right body and returns the id+expiry", async () => {
    const exp = "2026-06-01T00:00:00Z";
    const calls = install(() =>
      Response.json(
        { id: "SUB1", resource: "/me/todo/lists/L1/tasks", expirationDateTime: exp },
        { status: 201 },
      ),
    );
    const graph = new GraphClient(tp);
    const out = await createSubscription(graph, {
      listId: "L1",
      notificationUrl: "https://h.example.com/webhook",
      clientState: "cs1",
      expirationDateTime: exp,
    });
    expect(out).toEqual({ id: "SUB1", expirationDateTime: exp });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/subscriptions");
    expect(calls[0].method).toBe("POST");
    const body = JSON.parse(calls[0].body!);
    expect(body.changeType).toBe("created,updated,deleted");
    expect(body.resource).toBe("/me/todo/lists/L1/tasks");
    expect(body.notificationUrl).toBe("https://h.example.com/webhook");
    expect(body.clientState).toBe("cs1");
    expect(body.expirationDateTime).toBe(exp);
  });
});

describe("renewSubscription", () => {
  it("PATCHes the subscription with the new expiry", async () => {
    const exp = "2026-06-03T00:00:00Z";
    const calls = install(() => Response.json({ id: "SUB1", expirationDateTime: exp }, { status: 200 }));
    const graph = new GraphClient(tp);
    const out = await renewSubscription(graph, "SUB1", exp);
    expect(out.expirationDateTime).toBe(exp);
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/subscriptions/SUB1");
    expect(calls[0].method).toBe("PATCH");
  });
});

describe("deleteSubscription", () => {
  it("DELETEs the subscription (204)", async () => {
    const calls = install(() => new Response("", { status: 204 }));
    const graph = new GraphClient(tp);
    await deleteSubscription(graph, "SUB1");
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/subscriptions/SUB1");
    expect(calls[0].method).toBe("DELETE");
  });
});

describe("listGraphSubscriptions", () => {
  it("GETs /subscriptions and returns the value array", async () => {
    install(() =>
      Response.json(
        {
          value: [
            {
              id: "SUB1",
              resource: "/me/todo/lists/L1/tasks",
              notificationUrl: "https://h/webhook",
              expirationDateTime: "2026-06-01T00:00:00Z",
            },
          ],
        },
        { status: 200 },
      ),
    );
    const graph = new GraphClient(tp);
    const subs = await listGraphSubscriptions(graph);
    expect(subs.map((s) => s.id)).toEqual(["SUB1"]);
  });
});

describe("desiredExpiration", () => {
  it("returns an ISO string ~70h in the future from the given now", () => {
    const now = Date.parse("2026-05-29T00:00:00Z");
    const iso = desiredExpiration(now);
    expect(Date.parse(iso) - now).toBe(4_200 * 60_000);
  });
});
