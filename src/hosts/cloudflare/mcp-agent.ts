import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../../core/mcp/register-tools";
import { VERSION } from "../../core/version";
import type { Props } from "../../core/types";
import { appEnv } from "./env";

export class MSToDoMCP extends McpAgent<Env, never, Props> {
  server = new McpServer({ name: "mstodo-mcp", version: VERSION });
  async init() {
    registerTools(this.server, { env: appEnv(this.env) });
  }
}
