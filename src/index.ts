import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { MSToDoMCP } from "./mcp/agent";
import { TodoIndex } from "./cache/index-do";
import { OWNER_DO_NAME } from "./cache/sql";
import AuthHandler from "./auth/handler";

export { MSToDoMCP, TodoIndex };

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  // serve(path, { binding }) — agents/mcp defaults binding to "MCP_OBJECT",
  // but our DO binding (wrangler.jsonc) is named TODO_INDEX. Without this
  // arg the SDK throws on first /mcp request: env.MCP_OBJECT is undefined.
  apiHandler: MSToDoMCP.serve("/mcp", { binding: "TODO_INDEX" }) as never,
  defaultHandler: AuthHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, service: "mstodo-mcp", version: "0.1.0-dev" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return oauthProvider.fetch(req, env, ctx);
  },

  // Phase 5: cron heartbeat. Pokes the singleton TodoIndex DO to (re-)arm its
  // delta-sync alarm if it went idle. No sync work happens in the Worker itself
  // — ensureSyncing() is a no-op when an alarm is already pending, so the cron
  // only matters when the DO has gone quiet (e.g. after a no-auth alarm bailout
  // or a lost alarm).
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const index = env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName(OWNER_DO_NAME));
    ctx.waitUntil(index.ensureSyncing());
  },
};
