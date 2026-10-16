import { OAuthError, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { log } from "../../core/log";
import { grantRefusal, refuseMcpRequest, refusalDescription } from "../../core/auth/grant";
import type { AppEnv } from "../../core/ports";
import type { Props } from "../../core/types";
import { authHandler, type ProviderEnv } from "./auth-handler";

export const MCP_PATH = "/mcp";

// MCP-side token lifetimes. Access tokens stay at the library default of one
// hour (the per-call epoch check in the tool layer revokes faster than any TTL
// could). Refresh tokens slide: a grant starts with 30 days and every refresh
// extends it to 14 days from then, so a connector unused for two weeks has to
// re-authorize. grant.ts caps a grant's total life regardless of use.
const ACCESS_TOKEN_TTL_SEC = 60 * 60;
const REFRESH_TOKEN_TTL_SEC = 30 * 86_400;
const REFRESH_TOKEN_IDLE_TTL_SEC = 14 * 86_400;

// The host's MCP transport, reached only after the grant check below passed.
export interface McpHandler<E> {
  fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response>;
}

// The OAuth front both hosts run: provider options, our authorization flow as
// the default handler, and the per-request grant gate in front of MCP. Each
// host wraps it in `new OAuthProvider(...)` with its own MCP transport and its
// own Env → AppEnv conversion.
//
// `origin` is per request because the canonical resource is the server's own
// URL, and the same code is deployed under more than one hostname. The resource
// must equal what existing grants carry (the URL the client connected to), or
// every connected client is signed out — see the library's migration-1.x.md.
export function oauthProviderOptions<E extends ProviderEnv>(opts: {
  origin: string;
  mcpHandler: McpHandler<E>;
  toAppEnv: (env: E) => AppEnv;
}): OAuthProviderOptions<E> {
  const { origin, mcpHandler, toAppEnv } = opts;

  // The grant check for MCP traffic runs here, on every request, against the
  // props of the token presented on that request (ctx.props). It can't live
  // only in a session object: McpAgent keeps the props of the token that
  // started the session and never refreshes them. A refused grant gets a 401
  // invalid_token, so the client refreshes — which tokenExchangeCallback then
  // refuses — and starts a fresh authorization.
  const apiHandler = {
    async fetch(req: Request, env: E, ctx: ExecutionContext & { props?: unknown }): Promise<Response> {
      const refused = await refuseMcpRequest(toAppEnv(env), ctx.props as Partial<Props> | undefined);
      return refused ?? mcpHandler.fetch(req, env, ctx);
    },
  };

  return {
    apiRoute: MCP_PATH,
    apiHandler: apiHandler as never,
    defaultHandler: authHandler(toAppEnv) as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    resourceMetadata: { resource: `${origin}${MCP_PATH}` },
    accessTokenTTL: ACCESS_TOKEN_TTL_SEC,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SEC,
    refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_SEC,
    tokenExchangeCallback: async ({ grantType, props, env }) => {
      if (grantType !== "refresh_token") return;
      const refusal = await grantRefusal(toAppEnv(env), props as Partial<Props>);
      if (refusal) {
        // invalid_grant makes the library revoke this grant, and makes the MCP
        // client start a fresh authorization instead of retrying.
        log.warn("mcp_refresh_refused", { reason: refusal });
        throw new OAuthError("invalid_grant", { description: refusalDescription(refusal) });
      }
    },
    onError: ({ status, code, internal }) => {
      log.warn("oauth_error", { status, code, ...internal });
    },
  };
}
