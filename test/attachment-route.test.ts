// GET /api/v1/attachments/{sid} through the shared OAuth front on Workers:
// Workers KV, and the TodoIndex DO over RPC behind ownerIndex. Twin:
// test-node/attachment-route.test.ts.
import { describe, it, afterEach, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { appEnv } from "../src/hosts/cloudflare/env";
import { oauthFront } from "../src/hosts/shared/oauth";
import { graphAttachments, runAttachmentRouteChecks } from "./_attachment-route-checks";
import { ORIGIN, stubMicrosoft } from "../test-node/_oauth-client";

afterEach(() => vi.unstubAllGlobals());

describe("attachment download route (workers)", () => {
  it("streams an attachment's bytes behind an /api/v1 token and maps every refusal", async () => {
    stubMicrosoft("test-owner@example.com", graphAttachments);
    // The streaming path: no blob store, so every download reaches Graph.
    // test-node/blob-store.test.ts covers the stored copy.
    // Env types BLOBS as required (it is declared in wrangler.example.jsonc),
    // and this test runs without a blob store; hence the cast through unknown.
    const raw = { ...(env as unknown as Env), BLOBS: undefined } as unknown as Env;
    const front = oauthFront<Env>({
      origin: ORIGIN,
      toAppEnv: appEnv,
      mcpHandler: { fetch: async () => new Response("mcp") },
    });
    await runAttachmentRouteChecks(appEnv(raw), (req) => front.fetch(req, raw, createExecutionContext()));
  });
});
