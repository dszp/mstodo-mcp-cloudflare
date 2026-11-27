import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../version";

// Largest combined count of array elements and object keys one tools/call may
// carry. The SDK leaves this unlimited unless set (GHSA-46jr-4wx8-v453: a large
// argument payload can exhaust memory during schema validation). The biggest
// real inputs — set_list_config, set_link_rules — stay in the hundreds.
export const MAX_TOOL_INPUT_ELEMENTS = 10_000;

// Every host builds its server here, so the limit can't be set on one host and
// missed on another.
export function createMcpServer(): McpServer {
  return new McpServer(
    { name: "mstodo-mcp", version: VERSION },
    { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );
}
