// Cloudflare Access through the shared OAuth front on Workers (Workers KV, the
// TodoIndex DO). worker.ts itself isn't loaded (it pulls in the MCP SDK); the
// socket handler is a stand-in. Twin: test-node/access-flow.test.ts.
import { describe, it, afterEach, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { appEnv } from "../src/hosts/cloudflare/env";
import { oauthFront } from "../src/hosts/shared/oauth";
import { handleAppleAssociation } from "@potem/core/auth/apple-association";
import { ORIGIN, REDIRECT_URI } from "../test-node/_oauth-client";
import { runAccessHalfConfiguredChecks, runAccessOffChecks, runAccessOnChecks } from "./_access-flow-checks";
import { ACCESS_VARS, AUD } from "./_access-keys";

afterEach(() => vi.unstubAllGlobals());

function host(vars: Record<string, string>) {
  const raw = { ...(env as unknown as Env), ...vars } as Env;
  const front = oauthFront<Env>({
    origin: ORIGIN,
    toAppEnv: appEnv,
    mcpHandler: { fetch: async () => new Response("mcp") },
    socketHandler: async () => new Response("socket"),
  });
  const fetch = async (req: Request) =>
    handleAppleAssociation(req, appEnv(raw)) ?? front.fetch(req, raw, createExecutionContext());
  const socket = async (headers: Headers) => {
    const res = await fetch(new Request(`${ORIGIN}/api/v1/sync/socket`, { headers }));
    return res.status === 200 && (await res.text()) === "socket";
  };
  // The host env is rebuilt from raw on every request, so a change here is
  // what the next request sees.
  const setVar = (name: "ACCESS_HANDOFF_REDIRECT_URIS", value: string | undefined) => {
    (raw as unknown as Record<string, string | undefined>)[name] = value;
  };
  return { env: appEnv(raw), fetch, socket, setVar };
}

describe("Cloudflare Access (workers)", () => {
  it("gates /api/v1 and the socket, runs /app/signin and hands the token over at redemption", async () => {
    const h = host({ ...ACCESS_VARS, ACCESS_HANDOFF_REDIRECT_URIS: REDIRECT_URI });
    await runAccessOnChecks(h.env, h.fetch, h.socket, h.setVar);
  });
  it("changes nothing when not configured", async () => {
    const h = host({});
    await runAccessOffChecks(h.fetch, h.socket);
  });
  it("fails closed when half configured", async () => {
    const h = host({ ACCESS_AUD: AUD });
    await runAccessHalfConfiguredChecks(h.fetch, h.socket);
  });
});
