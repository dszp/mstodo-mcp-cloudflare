// /api/v1 through the shared OAuth front on Workers: Workers KV, and the
// TodoIndex DO over RPC behind ownerIndex. worker.ts itself isn't loaded (it
// pulls in the MCP SDK, which this pool can't resolve); it only adds /health
// and the capability endpoints in front of this. Twin: test-node/api-routes.test.ts.
import { describe, it, afterEach, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { appEnv } from "../src/hosts/cloudflare/env";
import { oauthFront } from "../src/hosts/shared/oauth";
import { runApiRouteChecks } from "./_api-route-checks";
import { ORIGIN, stubMicrosoft } from "../test-node/_oauth-client";

afterEach(() => vi.unstubAllGlobals());

describe("client sync API routes (workers)", () => {
  it("serves the feed, task, search and info routes behind an /api/v1 token and the grant gate", async () => {
    stubMicrosoft("test-owner@example.com");
    const raw = env as unknown as Env;
    const front = oauthFront<Env>({
      origin: ORIGIN,
      toAppEnv: appEnv,
      mcpHandler: { fetch: async () => new Response("mcp") },
    });
    await runApiRouteChecks(appEnv(raw), (req) => front.fetch(req, raw, createExecutionContext()));
  });
});
