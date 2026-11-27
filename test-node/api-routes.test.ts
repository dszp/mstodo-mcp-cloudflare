// /api/v1 through the Node host's full handler (origin rewrite, body caps,
// OAuth front). Twin: test/api-routes.test.ts.
import { describe, it, afterEach, vi } from "vitest";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { buildNodeEnv } from "../src/hosts/node/env";
import { createHandler } from "../src/hosts/node/http";
import { runApiRouteChecks } from "../test/_api-route-checks";
import { ORIGIN, stubMicrosoft } from "./_oauth-client";

afterEach(() => vi.unstubAllGlobals());

describe("client sync API routes (node host)", () => {
  it("serves the feed, task, search and info routes behind an /api/v1 token and the grant gate", async () => {
    stubMicrosoft("test-owner@example.com");
    const { env } = buildNodeEnv(openDatabase(":memory:"), {
      TIMEZONE: "America/New_York",
      OWNER_EMAIL: "test-owner@example.com",
      MS_TENANT_ID: "test-tenant",
      MS_CLIENT_ID: "test-client",
      MS_CLIENT_SECRET: "test-secret",
      ENABLE_CHECKLIST_CACHE: "true",
    });
    const handler = createHandler(env, { publicOrigin: ORIGIN });
    await runApiRouteChecks(env, handler.fetch);
    await handler.drain();
  });
});
