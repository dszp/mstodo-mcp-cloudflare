// The Node host's push-socket token check (docs/SYNC-API.md section 7.3):
// only an /api/v1 token that passes the grant gate opens a socket.
import { describe, it, expect, afterEach, vi } from "vitest";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { buildNodeEnv } from "../src/hosts/node/env";
import { createHandler } from "../src/hosts/node/http";
import { ORIGIN, oauthClient, stubMicrosoft } from "./_oauth-client";

afterEach(() => vi.unstubAllGlobals());

const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

describe("push socket authorization (node host)", () => {
  it("accepts an /api/v1 token and refuses an /mcp token, a bad one, or none", async () => {
    stubMicrosoft("test-owner@example.com");
    const { env } = buildNodeEnv(openDatabase(":memory:"), {
      OWNER_EMAIL: "test-owner@example.com",
      MS_TENANT_ID: "test-tenant",
      MS_CLIENT_ID: "test-client",
      MS_CLIENT_SECRET: "test-secret",
    });
    const handler = createHandler(env, { publicOrigin: ORIGIN });
    const client = oauthClient(handler.fetch);
    const api = await client.connect(`${ORIGIN}/api/v1`);
    const mcp = await client.connect(`${ORIGIN}/mcp`);

    const ok = await handler.authorizeSocket(bearer(api.access_token));
    expect(ok?.exp).toBeGreaterThan(Date.now());
    expect(await handler.authorizeSocket(bearer(mcp.access_token))).toBeNull();
    expect(await handler.authorizeSocket(bearer("u:g:bogus"))).toBeNull();
    expect(await handler.authorizeSocket(new Headers())).toBeNull();
    // Revoking every grant refuses the next upgrade.
    await env.ownerIndex().revokeAllGrants();
    expect(await handler.authorizeSocket(bearer(api.access_token))).toBeNull();
    await handler.drain();
  });
});
