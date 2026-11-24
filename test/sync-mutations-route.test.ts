// POST /api/v1/sync/mutations through the shared OAuth front on Workers: the
// TodoIndex DO over RPC, Workers KV, and a counted waitUntil. Twin:
// test-node/sync-mutations-route.test.ts.
import { describe, it, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { appEnv } from "../src/hosts/cloudflare/env";
import { oauthFront } from "../src/hosts/shared/oauth";
import { runSyncMutationRouteChecks } from "./_sync-mutation-route-checks";
import { ORIGIN } from "../test-node/_oauth-client";

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/v1/sync/mutations (workers)", () => {
  it("applies a batch behind an /api/v1 token, under one write lease and waitUntil", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = env as unknown as Env;
    // The pool's bindings turn My Day on; these checks need it off.
    const toAppEnv = (e: Env) => ({ ...appEnv(e), ENABLE_MY_DAY: "false" });
    const front = oauthFront<Env>({ origin: ORIGIN, toAppEnv, mcpHandler: { fetch: async () => new Response("mcp") } });
    let deferred = 0;
    const contexts: ExecutionContext[] = [];
    await runSyncMutationRouteChecks(
      toAppEnv(raw),
      (req) => {
        const ctx = createExecutionContext();
        const waitUntil = ctx.waitUntil.bind(ctx);
        ctx.waitUntil = (p) => {
          deferred++;
          waitUntil(p);
        };
        contexts.push(ctx);
        return front.fetch(req, raw, ctx);
      },
      { deferred: () => deferred },
    );
    for (const ctx of contexts) await waitOnExecutionContext(ctx);
  });
});
