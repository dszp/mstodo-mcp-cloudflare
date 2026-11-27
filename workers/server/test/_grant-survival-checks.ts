// Grant survival across the switch from the combined OAuthProvider (one
// resource, <origin>/mcp) to the role-based authorization server with two
// resources (/mcp and /api/v1). Run on both hosts' KV: test/grant-survival.test.ts
// (Workers KV + the TodoIndex DO) and test-node/grant-survival.test.ts (SQLite).
//
// Grants are issued under the OLD configuration, frozen below exactly as
// src/hosts/shared/oauth.ts built it before the switch, then the NEW front
// is built over the same KV and the same tokens are presented to it.
import { expect } from "vitest";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { refuseMcpRequest } from "@potem/core/auth/grant";
import type { AppEnv } from "@potem/core/ports";
import type { Props } from "@potem/core/types";
import { authHandler, type ProviderEnv } from "../src/hosts/shared/auth-handler";
import { oauthFront } from "../src/hosts/shared/oauth";
import { ORIGIN, oauthClient } from "../test-node/_oauth-client";

const MCP = `${ORIGIN}/mcp`;
const API = `${ORIGIN}/api/v1`;

// The combined provider as deployed before the switch (commit d0ccb4f).
function oldProvider<E extends AppEnv>() {
  return new OAuthProvider<E & ProviderEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(_req: Request, env: E, ctx: ExecutionContext & { props?: unknown }) {
        return (await refuseMcpRequest(env, ctx.props as Partial<Props>)) ?? Response.json({ ok: "old" });
      },
    } as never,
    defaultHandler: authHandler<E & ProviderEnv>((e) => e) as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    resourceMetadata: { resource: MCP },
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 86_400,
    refreshTokenIdleTTL: 14 * 86_400,
  });
}

// The new front, with an MCP stand-in that proves the grant gate passed and
// which grant's props it saw.
function newFront<E extends AppEnv>() {
  return oauthFront<E>({
    origin: ORIGIN,
    toAppEnv: (e) => e,
    mcpHandler: {
      async fetch(_req, _env, ctx) {
        return Response.json({ ok: "new", epoch: (ctx.props as Partial<Props> | undefined)?.epoch });
      },
    },
  });
}

type Tokens = { access_token: string; refresh_token: string; clientId: string };

// Strips the resource binding from a grant and its access tokens, as a grant
// written by library 0.x looks in KV.
async function unbind(env: AppEnv, accessToken: string) {
  const [userId, grantId] = accessToken.split(":");
  const grantKey = `grant:${userId}:${grantId}`;
  const grant = (await env.OAUTH_KV.get<Record<string, unknown>>(grantKey, "json"))!;
  expect(["grant.resource before unbind", grant.resource]).toEqual(["grant.resource before unbind", MCP]);
  delete grant.resource;
  await env.OAUTH_KV.put(grantKey, JSON.stringify(grant));
  const { keys } = await env.OAUTH_KV.list({ prefix: `token:${userId}:${grantId}:` });
  expect(["access tokens on the grant", keys.length]).toEqual(["access tokens on the grant", 1]);
  for (const { name } of keys) {
    const rec = (await env.OAUTH_KV.get<Record<string, unknown>>(name, "json"))!;
    expect(["token.audience before unbind", rec.audience]).toEqual(["token.audience before unbind", MCP]);
    delete rec.audience;
    await env.OAUTH_KV.put(name, JSON.stringify(rec));
  }
}

export async function runGrantSurvivalChecks<E extends AppEnv>(env: E, ctx: ExecutionContext) {
  const old = oldProvider<E>();
  // The combined provider caches its helpers on env.OAUTH_PROVIDER; give it a copy.
  const oldClient = oauthClient((req) => old.fetch(req, { ...env } as E & ProviderEnv, ctx));

  // Issued under the old configuration: a client that names the resource
  // (Claude), one that omits it, and one we then strip to a pre-1.0 record.
  const named: Tokens = await oldClient.connect(MCP);
  const omitted: Tokens = await oldClient.connect(null);
  const legacy: Tokens = await oldClient.connect(MCP);
  await unbind(env, legacy.access_token);

  const front = newFront<E>();
  const client = oauthClient((req) => front.fetch(req, env, ctx));
  const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
  const status = async (label: string, path: string, token: string, want: number) => {
    const res = await client.send(path, bearer(token));
    expect([label, res.status]).toEqual([label, want]);
    return res;
  };
  const refresh = async (label: string, t: Tokens, resource?: string) => {
    const res = await client.send(
      "/token",
      client.form({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: t.clientId,
        ...(resource ? { resource } : {}),
      }),
    );
    expect([label, res.status]).toEqual([label, 200]);
    const body = (await res.json()) as { access_token: string; refresh_token: string; resource?: string };
    expect([`${label}: resource`, body.resource]).toEqual([`${label}: resource`, MCP]);
    return { ...body, clientId: t.clientId };
  };

  // 1. Old access tokens are accepted on /mcp and refused on /api/v1.
  for (const [label, t] of [["named", named], ["omitted", omitted], ["legacy unbound", legacy]] as const) {
    const res = await status(`old ${label} token on /mcp`, "/mcp", t.access_token, 200);
    expect([`old ${label} token reached MCP`, ((await res.json()) as { ok: string }).ok]).toEqual([
      `old ${label} token reached MCP`,
      "new",
    ]);
    await status(`old ${label} token on /api/v1`, "/api/v1/sync/changes", t.access_token, 401);
  }

  // 2. Old refresh tokens refresh under the new server (with and without
  // `resource`, since clients differ), and the refreshed token works on /mcp
  // only.
  const r1 = await refresh("refresh named, resource sent", named, MCP);
  const r2 = await refresh("refresh omitted, no resource", omitted);
  const r3 = await refresh("refresh legacy unbound, no resource", legacy);
  for (const [label, t] of [["named", r1], ["omitted", r2], ["legacy", r3]] as const) {
    await status(`refreshed ${label} token on /mcp`, "/mcp", t.access_token, 200);
    await status(`refreshed ${label} token on /api/v1`, "/api/v1/sync/info", t.access_token, 401);
  }
  // A refresh may not retarget the grant to the other resource.
  const retarget = await client.send(
    "/token",
    client.form({ grant_type: "refresh_token", refresh_token: r1.refresh_token, client_id: r1.clientId, resource: API }),
  );
  expect(["refresh retargeted to /api/v1", retarget.status]).toEqual(["refresh retargeted to /api/v1", 400]);

  // 3. A new authorization without `resource` yields an /mcp token.
  const fresh = await client.connect(null);
  expect(["new authorization, no resource", fresh.resource]).toEqual(["new authorization, no resource", MCP]);
  await status("new default token on /mcp", "/mcp", fresh.access_token, 200);
  await status("new default token on /api/v1", "/api/v1/sync/info", fresh.access_token, 401);

  // 4. An /api/v1 token works there and is refused on /mcp.
  const app = await client.connect(API);
  expect(["new authorization for /api/v1", app.resource]).toEqual(["new authorization for /api/v1", API]);
  await status("/api/v1 token on /api/v1", "/api/v1/sync/info", app.access_token, 200);
  await status("/api/v1 token on /mcp", "/mcp", app.access_token, 401);

  // 5. Discovery: each resource publishes its own metadata, naming this issuer.
  for (const [path, resource] of [["/mcp", MCP], ["/api/v1", API]]) {
    const res = await client.send(`/.well-known/oauth-protected-resource${path}`);
    expect([`metadata ${path}`, res.status]).toEqual([`metadata ${path}`, 200]);
    expect(await res.json()).toMatchObject({ resource, authorization_servers: [ORIGIN] });
  }
  const as = await client.send("/.well-known/oauth-authorization-server");
  expect(await as.json()).toMatchObject({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/authorize`,
    token_endpoint: `${ORIGIN}/token`,
    registration_endpoint: `${ORIGIN}/register`,
    protected_resources: [MCP, API],
  });
}
