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

describe("runSyncCycle creates subscriptions for the roster", () => {
  it("after a roster baseline, a subscription exists for the synced list", async () => {
    await signIn();
    const stub = indexStub("cycle-subs-1");
    let n = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      const m = init?.method ?? "GET";
      if (u.includes("/me/todo/lists/delta")) {
        return Response.json(
          {
            value: [{ id: "L1", displayName: "Work" }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/todo/lists/delta?$deltatoken=z",
          },
          { status: 200 },
        );
      }
      if (u.includes("/tasks/delta")) {
        return Response.json(
          { value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/x?$deltatoken=z" },
          { status: 200 },
        );
      }
      if (u.endsWith("/subscriptions") && m === "POST") {
        const body = JSON.parse(init!.body as string);
        return Response.json(
          { id: `SUB${++n}`, resource: body.resource, expirationDateTime: body.expirationDateTime },
          { status: 201 },
        );
      }
      if (u.endsWith("/subscriptions") && m === "GET") return Response.json({ value: [] }, { status: 200 });
      // Substrate scan (My Day enabled in tests): return an empty folder.
      if (u.includes("substrate.office.com")) return Response.json({ value: [] }, { status: 200 });
      if (u.includes("login.microsoftonline.com"))
        return Response.json({ access_token: "EXO", expires_in: 3600 }, { status: 200 });
      return new Response(`unscripted ${m} ${u}`, { status: 404 });
    }) as unknown as typeof fetch;

    await stub.runSyncCycle();
    const subs = await stub.getSubscriptions();
    expect(subs.map((s) => s.list_id)).toContain("L1");
  });
});
