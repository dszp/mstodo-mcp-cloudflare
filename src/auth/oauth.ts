import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { MSToDoMCP } from "../mcp/agent";
import { log } from "../log";
import AuthHandler from "./handler";
import { grantRefusal, refuseMcpRequest, refusalDescription } from "./grant";
import type { Props } from "../types";

export const MCP_PATH = "/mcp";

// MCP-side token lifetimes. Access tokens stay at the library default of one
// hour (the per-call epoch check in the tool layer revokes faster than any TTL
// could). Refresh tokens slide: a grant starts with 30 days and every refresh
// extends it to 14 days from then, so a connector unused for two weeks has to
// re-authorize. grant.ts caps a grant's total life regardless of use.
const ACCESS_TOKEN_TTL_SEC = 60 * 60;
const REFRESH_TOKEN_TTL_SEC = 30 * 86_400;
const REFRESH_TOKEN_IDLE_TTL_SEC = 14 * 86_400;

// Built per request because the canonical resource is this Worker's own URL,
// and the same code is deployed under more than one hostname. The resource
// must equal what existing grants carry (the URL the client connected to), or
// every connected client is signed out — see the library's migration-1.x.md.
// serve(path, { binding }) — agents/mcp defaults binding to "MCP_OBJECT", but
// our DO binding (wrangler.jsonc) is named TODO_INDEX. Without this arg the SDK
// throws on first /mcp request: env.MCP_OBJECT is undefined.
const mcpHandler = MSToDoMCP.serve(MCP_PATH, { binding: "TODO_INDEX" });

// The grant check for MCP traffic runs here, on every request, against the
// props of the token presented on that request (ctx.props). It can't live only
// in the session Durable Object: McpAgent keeps the props of the token that
// started the session and never refreshes them. A refused grant gets a 401
// invalid_token, so the client refreshes — which tokenExchangeCallback then
// refuses — and starts a fresh authorization.
const apiHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext & { props?: unknown }): Promise<Response> {
    const refused = await refuseMcpRequest(env, ctx.props as Partial<Props> | undefined);
    return refused ?? mcpHandler.fetch(req, env, ctx);
  },
};

export function buildOAuthProvider(origin: string): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: MCP_PATH,
    apiHandler: apiHandler as never,
    defaultHandler: AuthHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    resourceMetadata: { resource: `${origin}${MCP_PATH}` },
    accessTokenTTL: ACCESS_TOKEN_TTL_SEC,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SEC,
    refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_SEC,
    tokenExchangeCallback: async ({ grantType, props, env }) => {
      if (grantType !== "refresh_token") return;
      const refusal = await grantRefusal(env, props as Partial<Props>);
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
  });
}
