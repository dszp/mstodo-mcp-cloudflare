import { MSToDoMCP } from "./mcp-agent";
import { MCP_PATH, oauthFront } from "../shared/oauth";
import { appEnv } from "./env";

// serve(path, { binding }) — agents/mcp defaults binding to "MCP_OBJECT", but
// our DO binding (wrangler.jsonc) is named TODO_INDEX. Without this arg the SDK
// throws on first /mcp request: env.MCP_OBJECT is undefined.
const mcpHandler = MSToDoMCP.serve(MCP_PATH, { binding: "TODO_INDEX" });

// Built per request: the resources are this Worker's own URL (see
// authorizationServerOptions). Everything else — endpoints, TTLs, the grant
// gate in front of /mcp and /api/v1, the API routes — is shared with the Node
// host.
export function buildOAuthFront(origin: string) {
  return oauthFront<Env>({ origin, mcpHandler, toAppEnv: appEnv });
}
