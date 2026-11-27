// Grants issued by the combined OAuthProvider keep working under the
// role-based authorization server (Workers KV, the TodoIndex DO over RPC).
// Twin: test-node/grant-survival.test.ts.
import { describe, it, afterEach, vi } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { runGrantSurvivalChecks } from "./_grant-survival-checks";
import { stubMicrosoft } from "../test-node/_oauth-client";
import { testAppEnv } from "./_app-env";

afterEach(() => vi.unstubAllGlobals());

describe("grant survival across the role-based switch (workers)", () => {
  it("accepts and refreshes old /mcp grants, and keeps /mcp and /api/v1 tokens apart", async () => {
    stubMicrosoft("test-owner@example.com");
    await runGrantSurvivalChecks(testAppEnv(), createExecutionContext());
  });
});
