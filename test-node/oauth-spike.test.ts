import { describe, it, expect, vi, afterEach } from "vitest";
import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { openDatabase, sqlDb } from "../src/hosts/node/sqlite-db";
import { sqliteKv, type OAuthKvStore } from "../src/hosts/node/sqlite-kv";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";
import { grantRefusal, refuseMcpRequest, refusalDescription } from "../src/core/auth/grant";
import { SCOPES, TOKENS_KEY } from "../src/core/auth/microsoft";
import AuthHandler from "../src/hosts/cloudflare/auth-handler";
import type { AppEnv } from "../src/core/ports";
import type { Props } from "../src/core/types";

// Spike (Task 9): does @cloudflare/workers-oauth-provider run on Node, driving
// OUR auth front (consent page, Microsoft callback, OWNER_EMAIL gate, grant
// epoch) over SQLite-backed KV and an in-process IndexCore? The provider
// options below are copied from buildOAuthProvider (src/hosts/cloudflare/oauth.ts);
// only the /mcp handler differs — it echoes the grant's epoch instead of
// serving MCP, because McpAgent is Cloudflare-only.

const ORIGIN = "https://mcp.test"; // https: the library's __Host- cookies are Secure
const REDIRECT_URI = "http://localhost:9/cb";

// The env the provider and auth-handler see. The library types env as a free
// generic (it never constrains OAUTH_KV), so this declaration is where the
// compiler checks our KV against the surface the library actually calls.
type SpikeEnv = AppEnv & {
  OAUTH_KV: OAuthKvStore;
  TODO_INDEX_DO: { idFromName(name: string): string; get(id: string): IndexCore };
};

function nodeEnv() {
  const db = openDatabase(":memory:");
  const state = stateStore(db);
  const oauthKv = sqliteKv(db, "OAUTH_KV");
  const env: AppEnv & { OAUTH_KV: OAuthKvStore } = {
    TIMEZONE: "America/New_York",
    OWNER_EMAIL: "test-owner@example.com",
    MS_TENANT_ID: "test-tenant",
    MS_CLIENT_ID: "test-client",
    MS_CLIENT_SECRET: "test-secret",
    ENABLE_MY_DAY: "true",
    OAUTH_KV: oauthKv,
    TODO_CACHE: sqliteKv(db, "TODO_CACHE"),
    ownerIndex: () => core as never,
  };
  const core = new IndexCore({ sql: sqlDb(db), state, alarms: state, env });
  core.bootstrap();
  // auth-handler wraps its env with the Cloudflare appEnv(), which REPLACES
  // ownerIndex with a lookup through the TODO_INDEX_DO namespace. Until the
  // handler takes an AppEnv directly (Task 10), the spike satisfies that
  // lookup with a stand-in namespace that returns the same IndexCore.
  const workerEnv: SpikeEnv = { ...env, TODO_INDEX_DO: { idFromName: () => "owner", get: () => core } };
  return { env, workerEnv, core };
}

function buildProvider(env: AppEnv) {
  return new OAuthProvider<SpikeEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(_req: Request, _env: unknown, ctx: { props?: unknown }) {
        const props = ctx.props as Partial<Props> | undefined;
        const refused = await refuseMcpRequest(env, props);
        return refused ?? Response.json({ epoch: props?.epoch });
      },
    } as never,
    defaultHandler: AuthHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    resourceMetadata: { resource: `${ORIGIN}/mcp` },
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 30 * 86_400,
    refreshTokenIdleTTL: 14 * 86_400,
    tokenExchangeCallback: async ({ grantType, props }) => {
      if (grantType !== "refresh_token") return;
      const refusal = await grantRefusal(env, props as Partial<Props>);
      if (refusal) throw new OAuthError("invalid_grant", { description: refusalDescription(refusal) });
    },
  });
}

function stubMicrosoft(mail: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/oauth2/v2.0/token")) {
        return new Response(
          JSON.stringify({ token_type: "Bearer", scope: SCOPES, expires_in: 3600, access_token: "a.e30.s", refresh_token: "rt" }),
        );
      }
      if (url === "https://graph.microsoft.com/v1.0/me") {
        return new Response(JSON.stringify({ id: "me-1", displayName: "Owner", mail, userPrincipalName: mail }));
      }
      return new Response("unscripted", { status: 404 });
    }),
  );
}

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

// One browser + one MCP client talking to provider.fetch, with a cookie jar.
function harness() {
  const { env, workerEnv, core } = nodeEnv();
  const provider = buildProvider(env);
  const jar = new Map<string, string>();
  async function send(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
    // ctx: the library only writes ctx.props; it never calls waitUntil.
    const res = await provider.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), workerEnv, ctx as unknown as ExecutionContext);
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      if (/max-age=0/i.test(attrs.join(";"))) jar.delete(name);
      else jar.set(name, pair.slice(i + 1));
    }
    return res;
  }
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

  // DCR → GET /authorize (consent) → POST approve → Microsoft callback.
  async function authorizeThroughCallback() {
    const reg = await send("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", client_name: "Spike" }),
    });
    expect(reg.status).toBe(201);
    const { client_id: clientId } = (await reg.json()) as { client_id: string };

    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: "client-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${ORIGIN}/mcp`,
    });
    const consent = await send(`/authorize?${q}`);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain("Allow Spike to use your Microsoft To&nbsp;Do?");
    expect([...jar.keys()].some((k) => k.startsWith("__Host-"))).toBe(true);
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1];

    const approved = await send("/authorize", form({ handle, decision: "approve" }));
    expect(approved.status).toBe(302);
    const ms = new URL(approved.headers.get("location")!);
    expect(ms.origin + ms.pathname).toBe("https://login.microsoftonline.com/test-tenant/oauth2/v2.0/authorize");
    expect(ms.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/microsoft/callback`);
    const msState = ms.searchParams.get("state")!;

    const callback = await send(`/auth/microsoft/callback?code=ms-code&state=${encodeURIComponent(msState)}`);
    return { callback, clientId, verifier };
  }

  return { env, core, send, form, authorizeThroughCallback };
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
