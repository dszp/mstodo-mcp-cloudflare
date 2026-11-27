// The push socket's route on Workers (docs/SYNC-API.md section 7.2): the
// /api/v1 resource server authenticates the upgrade, then the rebuilt request
// reaches the TodoIndex object, which says hello. An /mcp token is refused.
import { describe, it, expect, afterEach, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { appEnv } from "../src/hosts/cloudflare/env";
import { oauthFront } from "../src/hosts/shared/oauth";
import { ORIGIN, oauthClient, stubMicrosoft } from "../test-node/_oauth-client";

afterEach(() => vi.unstubAllGlobals());

describe("push socket route (workers)", () => {
  it("upgrades with an /api/v1 token and refuses an /mcp token or a plain GET", async () => {
    stubMicrosoft("test-owner@example.com");
    const raw = env as unknown as Env;
    const forwarded: Record<string, string>[] = [];
    const front = oauthFront<Env>({
      origin: ORIGIN,
      toAppEnv: appEnv,
      mcpHandler: { fetch: async () => new Response("mcp") },
      socketHandler: async (req, e, grant) => {
        const stub = e.TODO_INDEX_DO.getByName("socket-route");
        const headers = { upgrade: "websocket", "x-sync-exp": String(grant.exp) };
        forwarded.push(headers);
        return stub.fetch("https://todo-index/socket", { headers });
      },
    });
    const fetchFn = (req: Request) => front.fetch(req, raw, createExecutionContext());
    const client = oauthClient(fetchFn);
    const api = await client.connect(`${ORIGIN}/api/v1`);
    const mcp = await client.connect(`${ORIGIN}/mcp`);
    const open = (token: string, upgrade = true) =>
      fetchFn(
        new Request(`${ORIGIN}/api/v1/sync/socket`, {
          headers: { authorization: `Bearer ${token}`, ...(upgrade ? { upgrade: "websocket" } : {}) },
        }),
      );

    expect((await open(mcp.access_token)).status).toBe(401);
    expect((await open(api.access_token, false)).status).toBe(426);
    const res = await open(api.access_token);
    expect(res.status).toBe(101);
    const exp = Number(forwarded[0]["x-sync-exp"]);
    expect(exp).toBeGreaterThan(Date.now());
    expect(exp).toBeLessThanOrEqual(Date.now() + 3600_000 + 5_000);
    const ws = res.webSocket!;
    const first = new Promise<string>((r) => ws.addEventListener("message", (e) => r(String(e.data)), { once: true }));
    ws.accept();
    expect(JSON.parse(await first).type).toBe("hello");
    ws.close(1000, "done");
  });
});
