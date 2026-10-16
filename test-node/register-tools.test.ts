// test-node/register-tools.test.ts
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/core/mcp/register-tools";

describe("registerTools", () => {
  it("registers every tool with all three core hints", () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, { env: { TIMEZONE: "UTC" } as never });
    const tools = (server as unknown as { _registeredTools: Record<string, { annotations?: Record<string, unknown> }> })._registeredTools;
    expect(Object.keys(tools)).toContain("revoke_all_connections");
    expect(Object.keys(tools).length).toBe(52);
    for (const [name, t] of Object.entries(tools)) {
      expect(t.annotations, name).toMatchObject({ readOnlyHint: expect.any(Boolean), destructiveHint: expect.any(Boolean), openWorldHint: false });
    }
  });
});
