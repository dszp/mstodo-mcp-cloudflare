import {
  OAuthAuthorizationServer,
  OAuthError,
  OAuthResourceServer,
  type OAuthAuthorizationServerOptions,
} from "@cloudflare/workers-oauth-provider";
import { log } from "../../core/log";
import { grantRefusal, refuseMcpRequest, refusalDescription } from "../../core/auth/grant";
import { API_PATH, handleApiRequest, handlePublicApiRequest } from "../../core/api/router";
import type { AppEnv } from "../../core/ports";
import type { Props } from "../../core/types";
import { authHandler, isAuthUiPath, type ProviderEnv } from "./auth-handler";

export const MCP_PATH = "/mcp";
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
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    accessTokenTTL: ACCESS_TOKEN_TTL_SEC,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SEC,
    refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_SEC,
    tokenExchangeCallback: async ({ grantType, props, env }) => {
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
}) {
  const { origin, mcpHandler, toAppEnv } = opts;
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
    handler: { fetch: (req, env, ctx) => handleApiRequest(req, toAppEnv(env), ctx.props) },
  });

  const auth = authHandler<E & ProviderEnv>(toAppEnv);

  return {
    async fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (isAuthUiPath(path)) {
        return auth.fetch(req, { ...env, OAUTH_PROVIDER: authorizationServer.getOAuthApi(env) });
      }
      if (under(path, MCP_PATH) || path === resourceMetadataPath(MCP_PATH)) {
        return mcp.fetch(req, env, ctx);
      }
      if (under(path, API_PATH) || path === resourceMetadataPath(API_PATH)) {
        return (await handlePublicApiRequest(req, toAppEnv(env))) ?? api.fetch(req, env, ctx);
      }
      return authorizationServer.fetch(req, env, ctx);
    },
  };
}
