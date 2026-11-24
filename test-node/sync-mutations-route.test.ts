// POST /api/v1/sync/mutations through the Node host's full handler (origin
// rewrite, body caps, OAuth front, in-process index). Twin:
// test/sync-mutations-route.test.ts.
import { describe, it, afterEach, vi } from "vitest";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { buildNodeEnv } from "../src/hosts/node/env";
import { createHandler } from "../src/hosts/node/http";
import { runSyncMutationRouteChecks } from "../test/_sync-mutation-route-checks";
import { ORIGIN } from "./_oauth-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/v1/sync/mutations (node host)", () => {
  it("applies a batch behind an /api/v1 token, under one write lease", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env } = buildNodeEnv(openDatabase(":memory:"), {
      TIMEZONE: "America/New_York",
      OWNER_EMAIL: "test-owner@example.com",
      MS_TENANT_ID: "test-tenant",
      MS_CLIENT_ID: "test-client",
      MS_CLIENT_SECRET: "test-secret",
      ENABLE_CHECKLIST_CACHE: "true",
    });
    const handler = createHandler(env, { publicOrigin: ORIGIN });
    await runSyncMutationRouteChecks(env, handler.fetch);
    await handler.drain();
  });
});
