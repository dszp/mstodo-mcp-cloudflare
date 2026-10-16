import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../core/mcp/register-tools";
import { VERSION } from "../version";
import type { Props } from "../types";

export class MSToDoMCP extends McpAgent<Env, never, Props> {
  server = new McpServer({ name: "mstodo-mcp", version: VERSION });
  async init() {
    registerTools(this.server, { env: this.env });
  }
}
