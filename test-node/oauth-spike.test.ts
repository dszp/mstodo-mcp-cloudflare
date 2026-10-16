import { describe, it, expect, vi, afterEach } from "vitest";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { openDatabase, sqlDb } from "../src/hosts/node/sqlite-db";
import { sqliteKv, type OAuthKvStore } from "../src/hosts/node/sqlite-kv";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";
import type { AppEnv } from "../src/core/ports";
import { refusalDescription } from "../src/core/auth/grant";
import { TOKENS_KEY } from "../src/core/auth/microsoft";
import { oauthProviderOptions } from "../src/hosts/shared/oauth";
import type { ProviderEnv } from "../src/hosts/shared/auth-handler";
import type { Props } from "../src/core/types";
import { ORIGIN, REDIRECT_URI, oauthClient, stubMicrosoft } from "./_oauth-client";

// Spike (Task 9), kept as a drift guard: @cloudflare/workers-oauth-provider
// runs on Node with the SAME provider options both hosts use
// (oauthProviderOptions in src/hosts/shared/oauth.ts) driving OUR auth front
// (consent page, Microsoft callback, OWNER_EMAIL gate, grant epoch) over
// SQLite-backed KV and an in-process IndexCore. Only the /mcp handler differs:
// it echoes the grant's epoch instead of serving MCP.

// The env the provider and auth-handler see. The library types env as a free
// generic (it never constrains OAUTH_KV), so this declaration is where the
// compiler checks our KV against the surface the library actually calls.
type SpikeEnv = AppEnv & { OAUTH_KV: OAuthKvStore } & ProviderEnv;

function nodeEnv() {
  const db = openDatabase(":memory:");
  const state = stateStore(db);
  const env: AppEnv & { OAUTH_KV: OAuthKvStore } = {
    TIMEZONE: "America/New_York",
    OWNER_EMAIL: "test-owner@example.com",
    MS_TENANT_ID: "test-tenant",
    MS_CLIENT_ID: "test-client",
    MS_CLIENT_SECRET: "test-secret",
    ENABLE_MY_DAY: "true",
    OAUTH_KV: sqliteKv(db, "OAUTH_KV"),
    TODO_CACHE: sqliteKv(db, "TODO_CACHE"),
    ownerIndex: () => core as never,
  };
  const core = new IndexCore({ sql: sqlDb(db), state, alarms: state, env });
  core.bootstrap();
  return { env, core };
}

function buildProvider() {
  return new OAuthProvider<SpikeEnv>(
    oauthProviderOptions<SpikeEnv>({
      origin: ORIGIN,
      toAppEnv: (e) => e,
      mcpHandler: {
        async fetch(_req, _env, ctx) {
          return Response.json({ epoch: (ctx.props as Partial<Props> | undefined)?.epoch });
        },
      },
    }),
  );
}

function harness() {
  const { env, core } = nodeEnv();
  const provider = buildProvider();
  // ctx: the library only writes ctx.props; it never calls waitUntil.
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const client = oauthClient((req) => provider.fetch(req, env as SpikeEnv, ctx));
  return { env, core, ...client };
}

afterEach(() => vi.unstubAllGlobals());

describe("OAuth provider on Node (spike)", () => {
  it("issues, validates, refreshes and revokes a grant end to end", async () => {
    stubMicrosoft("test-owner@example.com");
    const { env, core, send, form, authorizeThroughCallback } = harness();
    const { callback, clientId, verifier } = await authorizeThroughCallback();

    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT_URI);
    expect(back.searchParams.get("state")).toBe("client-state");
    const code = back.searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect(await env.TODO_CACHE.get(TOKENS_KEY, "text")).not.toBeNull();

    const tok = await send(
      "/token",
      form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
    );
    expect(tok.status).toBe(200);
    const t1 = (await tok.json()) as { access_token: string; refresh_token: string };
    expect(t1.access_token).toBeTruthy();
    expect(t1.refresh_token).toBeTruthy();

    const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
    const { epoch } = await core.authState();
    const api = await send("/mcp", bearer(t1.access_token));
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ epoch });

    expect((await send("/mcp")).status).toBe(401);

    const ref = await send("/token", form({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId }));
    expect(ref.status).toBe(200);
    const t2 = (await ref.json()) as { access_token: string; refresh_token: string };
    expect(t2.access_token).not.toBe(t1.access_token);
    expect((await send("/mcp", bearer(t2.access_token))).status).toBe(200);

    // Security property (a): bumping the epoch kills the bearer on the next
    // request and refuses the refresh — the Node host keeps revocation.
    await core.revokeAllGrants();
    const revoked = await send("/mcp", bearer(t2.access_token));
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: "invalid_token", error_description: refusalDescription("grant_revoked") });
    const refused = await send("/token", form({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: clientId }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses a non-owner at the callback and stores no tokens", async () => {
    // Security property (b): the OWNER_EMAIL gate runs before anything persists.
    stubMicrosoft("someone-else@example.com");
    const { env, authorizeThroughCallback } = harness();
    const { callback } = await authorizeThroughCallback();
    expect(callback.status).toBe(403);
    expect(callback.headers.get("location")).toBeNull();
    expect(await env.TODO_CACHE.get(TOKENS_KEY, "text")).toBeNull();
    expect((await env.OAUTH_KV.list({ prefix: "grant:" })).keys).toEqual([]);
  });
});
