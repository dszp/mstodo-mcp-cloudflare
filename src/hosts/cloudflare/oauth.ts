import { MSToDoMCP } from "./mcp-agent";
import { MCP_PATH, oauthFront } from "../shared/oauth";
import { appEnv } from "./env";
import { OWNER_DO_NAME } from "../../core/index/sql";

// serve(path, { binding }) — agents/mcp defaults binding to "MCP_OBJECT", but
// our DO binding (wrangler.jsonc) is named TODO_INDEX. Without this arg the SDK
// throws on first /mcp request: env.MCP_OBJECT is undefined.
const mcpHandler = MSToDoMCP.serve(MCP_PATH, { binding: "TODO_INDEX" });

// Built per request: the resources are this Worker's own URL (see
// authorizationServerOptions). Everything else — endpoints, TTLs, the grant
// gate in front of /mcp and /api/v1, the API routes — is shared with the Node
// host.
export function buildOAuthFront(origin: string) {
  return oauthFront<Env>({ origin, mcpHandler, toAppEnv: appEnv, socketHandler: forwardSocket });
}

// Hands an authenticated push-socket upgrade to the index object. The request
// is rebuilt, so only what the Worker verified reaches the object: never a
// client-supplied x-sync-* header.
function forwardSocket(req: Request, env: Env, grant: { exp: number }): Promise<Response> {
  const stub = env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName(OWNER_DO_NAME));
  return stub.fetch("https://todo-index/socket", {
    headers: {
      upgrade: "websocket",
      "x-sync-exp": String(grant.exp),
      "x-sync-client": (req.headers.get("x-client-id") ?? "").slice(0, 100),
    },
  });
}
