// Cloudflare Access through the Node host's full handler (origin rewrite, body
// caps, OAuth front) and its socket upgrade check. Twin: test/access-flow.test.ts.
import { describe, it, expect, afterEach, vi } from "vitest";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { buildNodeEnv } from "../src/hosts/node/env";
import { createHandler } from "../src/hosts/node/http";
import { ORIGIN } from "./_oauth-client";
import { runAccessHalfConfiguredChecks, runAccessOffChecks, runAccessOnChecks } from "../test/_access-flow-checks";
import { ACCESS_VARS, AUD } from "../test/_access-keys";

afterEach(() => vi.unstubAllGlobals());

function host(vars: Record<string, string>) {
  const { env } = buildNodeEnv(openDatabase(":memory:"), {
    OWNER_EMAIL: "test-owner@example.com",
    MS_TENANT_ID: "test-tenant",
    MS_CLIENT_ID: "test-client",
    MS_CLIENT_SECRET: "test-secret",
    ...vars,
  });
  const handler = createHandler(env, { publicOrigin: ORIGIN });
  const socket = async (headers: Headers) => (await handler.authorizeSocket(headers)) !== null;
  return { env, handler, socket };
}

describe("Cloudflare Access (node host)", () => {
  it("gates /api/v1 and the socket, runs /app/signin and hands the token over at redemption", async () => {
    const h = host(ACCESS_VARS);
    await runAccessOnChecks(h.env, h.handler.fetch, h.socket);
    await h.handler.drain();
  });
  it("changes nothing when not configured", async () => {
    const h = host({});
    await runAccessOffChecks(h.handler.fetch, h.socket);
    await h.handler.drain();
  });
  it("serves the Apple association file when configured", async () => {
    const h = host({ APPLE_TEAM_ID: "ABCDE12345", APPLE_BUNDLE_IDS: "com.example.todo" });
    const res = await h.handler.fetch(new Request(`${ORIGIN}/.well-known/apple-app-site-association`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ webcredentials: { apps: ["ABCDE12345.com.example.todo"] } });
  });
  it("fails closed when half configured", async () => {
    const h = host({ ACCESS_AUD: AUD });
    await runAccessHalfConfiguredChecks(h.handler.fetch, h.socket);
    await h.handler.drain();
  });
});
