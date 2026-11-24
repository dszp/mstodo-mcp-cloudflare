// Grants issued by the combined OAuthProvider keep working under the
// role-based authorization server (SQLite KV). Twin: test/grant-survival.test.ts.
import { describe, it, afterEach, vi } from "vitest";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { buildNodeEnv } from "../src/hosts/node/env";
import { runGrantSurvivalChecks } from "../test/_grant-survival-checks";
import { stubMicrosoft } from "./_oauth-client";

afterEach(() => vi.unstubAllGlobals());

describe("grant survival across the role-based switch (node)", () => {
  it("accepts and refreshes old /mcp grants, and keeps /mcp and /api/v1 tokens apart", async () => {
    stubMicrosoft("test-owner@example.com");
    const { env } = buildNodeEnv(openDatabase(":memory:"), {
      TIMEZONE: "America/New_York",
      OWNER_EMAIL: "test-owner@example.com",
      MS_TENANT_ID: "test-tenant",
      MS_CLIENT_ID: "test-client",
      MS_CLIENT_SECRET: "test-secret",
    });
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    await runGrantSurvivalChecks(env, ctx);
  });
});
