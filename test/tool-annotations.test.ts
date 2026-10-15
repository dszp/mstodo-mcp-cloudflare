import { describe, expect, it } from "vitest";
// Import the agent SOURCE as a string (Vite ?raw) rather than the module — the
// MCP agent pulls in the SDK -> ajv, which the workers pool can't resolve (see
// test/_test-worker.ts). A static source check needs only the text, and it tests
// the real invariant: every tool registered via this.#tool("name") must have a
// matching entry in the central TOOL_ANNOTATIONS table (otherwise a new tool
// silently ships with only the bare base-default hints and no title).
import agentSource from "../src/mcp/agent.ts?raw";

describe("MCP tool annotations coverage", () => {
  // Tool names registered through the annotation-injecting wrapper.
  const registered = new Set(
    [...agentSource.matchAll(/#tool\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]),
  );
  // Keys of the TOOL_ANNOTATIONS table (each row is `  name: { title: ... }`).
  const annotated = new Set(
    [...agentSource.matchAll(/^ {2}([a-z0-9_]+): \{ title:/gm)].map((m) => m[1]),
  );

  it("finds the registered tools and the annotation table", () => {
    // Guard against the regexes silently matching nothing (e.g. a refactor that
    // renames #tool) — which would make the checks below vacuously pass.
    expect(registered.size).toBeGreaterThan(40);
    expect(annotated.size).toBeGreaterThan(40);
  });

  it("every registered tool has a TOOL_ANNOTATIONS entry", () => {
    const missing = [...registered].filter((name) => !annotated.has(name));
    expect(missing, `tools missing from TOOL_ANNOTATIONS: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no TOOL_ANNOTATIONS entries for tools that aren't registered", () => {
    const stale = [...annotated].filter((name) => !registered.has(name));
    expect(stale, `stale TOOL_ANNOTATIONS entries: ${stale.join(", ")}`).toEqual([]);
  });
});
