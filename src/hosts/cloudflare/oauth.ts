import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { MSToDoMCP } from "./mcp-agent";
import { MCP_PATH, oauthProviderOptions } from "../shared/oauth";
import { appEnv } from "./env";

// serve(path, { binding }) — agents/mcp defaults binding to "MCP_OBJECT", but
// our DO binding (wrangler.jsonc) is named TODO_INDEX. Without this arg the SDK
// throws on first /mcp request: env.MCP_OBJECT is undefined.
const mcpHandler = MSToDoMCP.serve(MCP_PATH, { binding: "TODO_INDEX" });

// Built per request: the canonical resource is this Worker's own URL (see
// oauthProviderOptions). The options — TTLs, endpoints, the per-request grant
// gate in front of /mcp — are shared with the Node host.
export function buildOAuthProvider(origin: string): OAuthProvider<Env> {
  return new OAuthProvider<Env>(oauthProviderOptions<Env>({ origin, mcpHandler, toAppEnv: appEnv }));
}
