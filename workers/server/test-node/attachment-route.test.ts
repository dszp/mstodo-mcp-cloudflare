// GET /api/v1/attachments/{sid} through the Node host's full handler (origin
// rewrite, body caps, OAuth front). Twin: test/attachment-route.test.ts.
import { describe, it, afterEach, vi } from "vitest";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { buildNodeEnv } from "../src/hosts/node/env";
import { createHandler } from "../src/hosts/node/http";
import { graphAttachments, runAttachmentRouteChecks } from "../test/_attachment-route-checks";
import { ORIGIN, stubMicrosoft } from "./_oauth-client";

afterEach(() => vi.unstubAllGlobals());

describe("attachment download route (node host)", () => {
  it("streams an attachment's bytes behind an /api/v1 token and maps every refusal", async () => {
    stubMicrosoft("test-owner@example.com", graphAttachments);
    const { env } = buildNodeEnv(openDatabase(":memory:"), {
      TIMEZONE: "America/New_York",
      OWNER_EMAIL: "test-owner@example.com",
      MS_TENANT_ID: "test-tenant",
      MS_CLIENT_ID: "test-client",
      MS_CLIENT_SECRET: "test-secret",
    });
    const handler = createHandler(env, { publicOrigin: ORIGIN });
    await runAttachmentRouteChecks(env, handler.fetch);
    await handler.drain();
  });
});
