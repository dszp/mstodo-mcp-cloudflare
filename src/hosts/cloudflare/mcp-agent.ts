import { McpAgent } from "agents/mcp";
import { registerTools } from "../../core/mcp/register-tools";
import { createMcpServer } from "../../core/mcp/server";
import type { Props } from "../../core/types";
import { appEnv } from "./env";

export class MSToDoMCP extends McpAgent<Env, never, Props> {
  server = createMcpServer();
  async init() {
    registerTools(this.server, { env: appEnv(this.env) });
  }
}
