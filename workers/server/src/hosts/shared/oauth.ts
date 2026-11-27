import {
  OAuthAuthorizationServer,
  OAuthError,
  OAuthResourceServer,
  type OAuthAuthorizationServerOptions,
} from "@cloudflare/workers-oauth-provider";
import { log } from "@potem/core/log";
import { grantRefusal, refuseMcpRequest, refusalDescription } from "@potem/core/auth/grant";
import { API_PATH, handleApiRequest, handlePublicApiRequest } from "@potem/core/api/router";
import { refuseApiRequest } from "@potem/core/auth/grant";
import type { AppEnv } from "@potem/core/ports";
import type { Props } from "@potem/core/types";
import { authHandler, isAuthUiPath, type ProviderEnv } from "./auth-handler";
import { accessRefusalResponse, checkAccess } from "@potem/core/auth/access";
import {
  APP_SIGNIN_PATH,
  HANDOFF_PROP,
  HANDOFF_SLOT,
  handleAppSignin,
  redeemAccessHandoff,
  withAccessToken,
  type HandoffSlot,
} from "./app-signin";

export const MCP_PATH = "/mcp";
const TOKEN_PATH = "/token";
export const SOCKET_PATH = `${API_PATH}/sync/socket`;

// A socket lives until its access token expires (seconds since the epoch); a
// token without an expiry gets the access-token lifetime from now.
function socketExpiry(expiresAtSec: number | undefined): number {
  return (expiresAtSec ?? Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SEC) * 1000;
}
export { API_PATH };

// Token lifetimes, shared by both resources. Access tokens stay at the library
// default of one hour (the per-request grant gate revokes faster than any TTL
// could). Refresh tokens slide: a grant starts with 30 days and every refresh
// extends it to 14 days from then, so a client unused for two weeks has to
// re-authorize. grant.ts caps a grant's total life regardless of use.
export const ACCESS_TOKEN_TTL_SEC = 60 * 60;
export const REFRESH_TOKEN_TTL_SEC = 30 * 86_400;
export const REFRESH_TOKEN_IDLE_TTL_SEC = 14 * 86_400;

// The host's MCP transport, reached only after the grant check below passed.
export interface McpHandler<E> {
  fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response>;
}

// The authorization-server options both hosts use: our endpoint paths, token
// lifetimes, the refresh-time grant check and error logging.
//
// Two protected resources share it, each token bound to exactly one (RFC 8707
// audience): `<origin>/mcp` for MCP clients and `<origin>/api/v1` for the sync
// app (docs/SYNC-API.md sections 8 and 18.1). A token for one is refused by
// the other.
//
// `defaultResource` and `legacyGrantResource` are both /mcp, and must stay so:
// - MCP clients that authorize without `resource` keep getting /mcp tokens,
//   as they did when /mcp was the only resource.
// - Grants and tokens from before resource binding (library 0.x) carry no
//   resource; the library treats them as bound to `legacyGrantResource`.
//   Changing it re-targets every such record (migration-1.x.md).
// Grants issued under the combined OAuthProvider are bound to `<origin>/mcp`,
// which is listed here unchanged, so they validate and refresh as before
// (test-node/grant-survival.test.ts).
//
// `origin` is per request because the resource is the server's own URL and
// the same code is deployed under more than one hostname. It must equal what
// existing grants carry (the URL the client connected to), or every connected
// client is signed out.
export function authorizationServerOptions<E>(opts: {
  origin: string;
  toAppEnv: (env: E) => AppEnv;
}): OAuthAuthorizationServerOptions<E> {
  const { origin, toAppEnv } = opts;
  const mcpResource = `${origin}${MCP_PATH}`;
  return {
    issuer: origin,
    resources: [mcpResource, `${origin}${API_PATH}`],
    defaultResource: mcpResource,
    legacyGrantResource: mcpResource,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: "/register",
    accessTokenTTL: ACCESS_TOKEN_TTL_SEC,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SEC,
    refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_SEC,
    tokenExchangeCallback: async ({ grantType, props, env }) => {
      // A grant from /app/signin carries the handle of a stored Cloudflare
      // Access token (app-signin.ts). At code redemption it moves out of the
      // grant into this request's slot, and the front adds the token to the
      // response; the grant keeps no trace of it.
      if (grantType === "authorization_code" && props && typeof props[HANDOFF_PROP] === "string") {
        const { [HANDOFF_PROP]: handle, ...rest } = props as Record<string, unknown>;
        const slot = (env as { [HANDOFF_SLOT]?: HandoffSlot })[HANDOFF_SLOT];
        if (slot) slot.handle = handle as string;
        return { newProps: rest };
      }
      if (grantType !== "refresh_token") return;
      const refusal = await grantRefusal(toAppEnv(env), props as Partial<Props>);
      if (refusal) {
        // invalid_grant makes the library revoke this grant, and makes the
        // client start a fresh authorization instead of retrying.
        log.warn("mcp_refresh_refused", { reason: refusal });
        throw new OAuthError("invalid_grant", { description: refusalDescription(refusal) });
      }
    },
    // Named fields only. The library's `internal.detail` may carry a caught
    // error or the offending request parameter, and a library update could add
    // fields to `internal`; neither should reach the logs unreviewed.
    onError: ({ status, code, internal }) => {
      log.warn("oauth_error", { status, code, category: internal?.category, reason: internal?.reason });
    },
  };
}

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
const resourceMetadataPath = (path: string) => `/.well-known/oauth-protected-resource${path}`;

// The OAuth front both hosts run, in front of everything but /health and the
// capability/webhook endpoints. Routing:
//
//   /authorize, /auth/*                our authorization flow (auth-handler.ts)
//   /mcp[/…] and its metadata          the /mcp resource server → grant gate → MCP
//   GET /api/v1/sync/info, no bearer   public probe: { server_id } only
//   /api/v1[/…] and its metadata       the /api/v1 resource server → core/api router
//   anything else                      the authorization server: AS metadata,
//                                      /token, /register; 404 otherwise
//
// Each resource server validates locally through the authorization server
// (same KV, same process) and refuses a token whose audience is the other
// resource.
export function oauthFront<E>(opts: {
  origin: string;
  mcpHandler: McpHandler<E>;
  toAppEnv: (env: E) => AppEnv;
  // The push socket (docs/SYNC-API.md section 7). Cloudflare forwards the
  // authenticated upgrade to the index object; the Node host serves upgrades
  // outside the fetch handler (authorizeSocket below) and passes none.
  socketHandler?: (req: Request, env: E, grant: { exp: number }) => Promise<Response>;
}) {
  const { origin, mcpHandler, toAppEnv, socketHandler } = opts;
  const authorizationServer = new OAuthAuthorizationServer<E>(authorizationServerOptions({ origin, toAppEnv }));
  const validateToken = (env: E) => async (resource: string, token: string) => {
    const valid = await authorizationServer.validateToken<Props>(resource, token, env);
    // The resource server answers a refused token with a bare 401 and, unlike
    // the combined provider, doesn't report it through onError. Log which
    // resource refused it: after a deploy, a run of these on /mcp is the sign
    // that existing grants didn't carry over.
    if (!valid) log.warn("token_refused", { resource: new URL(resource).pathname });
    return valid;
  };

  // The grant check for MCP traffic runs here, on every request, against the
  // props of the token presented on that request (ctx.props). It can't live
  // only in a session object: McpAgent keeps the props of the token that
  // started the session and never refreshes them. A refused grant gets a 401
  // invalid_token, so the client refreshes — which tokenExchangeCallback then
  // refuses — and starts a fresh authorization.
  const mcp = new OAuthResourceServer<E, Props>({
    resourceMetadata: { resource: `${origin}${MCP_PATH}`, authorization_servers: [origin] },
    validateToken,
    handler: {
      async fetch(req, env, ctx) {
        const refused = await refuseMcpRequest(toAppEnv(env), ctx.props);
        return refused ?? mcpHandler.fetch(req, env, ctx);
      },
    },
  });

  // The same grant check runs inside handleApiRequest, before any route.
  const api = new OAuthResourceServer<E, Props>({
    resourceMetadata: { resource: `${origin}${API_PATH}`, authorization_servers: [origin] },
    validateToken,
    handler: {
      async fetch(req, env, ctx) {
        if (new URL(req.url).pathname === SOCKET_PATH) {
          const refused = await refuseApiRequest(toAppEnv(env), ctx.props);
          if (refused) return refused;
          if (!socketHandler || req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return new Response("expected a websocket upgrade", { status: 426 });
          }
          return socketHandler(req, env, { exp: socketExpiry(ctx.auth.expiresAt) });
        }
        return handleApiRequest(req, toAppEnv(env), ctx.props, ctx);
      },
    },
  });

  const auth = authHandler<E & ProviderEnv>(toAppEnv);

  return {
    // The Node host's upgrade check: the same audience-checked validation and
    // grant gate as any /api/v1 request (section 18.7). Null refuses.
    // With Cloudflare Access configured, the upgrade must also carry a valid
    // Access token, as every /api/v1 request must.
    async authorizeSocket(headers: Headers, env: E): Promise<{ exp: number } | null> {
      const access = await checkAccess(headers, toAppEnv(env), { cookie: false, path: SOCKET_PATH });
      if (access.state === "refused") return null;
      const m = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "");
      if (!m) return null;
      const valid = await validateToken(env)(`${origin}${API_PATH}`, m[1]);
      if (!valid) return null;
      if (await refuseApiRequest(toAppEnv(env), valid.props)) return null;
      return { exp: socketExpiry(valid.expiresAt) };
    },

    async fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (isAuthUiPath(path)) {
        return auth.fetch(req, { ...env, OAUTH_PROVIDER: authorizationServer.getOAuthApi(env) });
      }
      if (under(path, MCP_PATH) || path === resourceMetadataPath(MCP_PATH)) {
        return mcp.fetch(req, env, ctx);
      }
      if (path === APP_SIGNIN_PATH) {
        const res = await handleAppSignin(req, toAppEnv(env), origin);
        if (res) return res;
      }
      // Cloudflare Access, when configured, gates every /api/v1 path before
      // anything else runs: the anonymous info probe, every route (including
      // ones added later) and the socket upgrade. Access at the edge already
      // checked; this check makes a gap in the edge configuration fail closed.
      // The resource metadata document stays outside, like the other OAuth
      // discovery endpoints.
      if (under(path, API_PATH)) {
        const access = await checkAccess(req.headers, toAppEnv(env), { cookie: false, path: API_PATH });
        if (access.state === "refused") return accessRefusalResponse(access);
      }
      if (under(path, API_PATH) || path === resourceMetadataPath(API_PATH)) {
        return (await handlePublicApiRequest(req, toAppEnv(env))) ?? api.fetch(req, env, ctx);
      }
      if (path === TOKEN_PATH && req.method === "POST") {
        const slot: HandoffSlot = {};
        const res = await authorizationServer.fetch(req, { ...env, [HANDOFF_SLOT]: slot }, ctx);
        if (!slot.handle) return res;
        const access = await redeemAccessHandoff(toAppEnv(env), slot.handle);
        return access ? withAccessToken(res, access) : res;
      }
      return authorizationServer.fetch(req, env, ctx);
    },
  };
}
