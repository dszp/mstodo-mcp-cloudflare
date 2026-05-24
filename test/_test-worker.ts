// Entry worker for @cloudflare/vitest-pool-workers. The pool instantiates DO
// classes from this module lazily (only when a test addresses the binding), so
// we re-export TodoIndex here. MSToDoMCP is intentionally NOT re-exported: it
// pulls in the MCP SDK → ajv, which the workers pool can't resolve, and no DO
// test instantiates the TODO_INDEX (agent) binding.
export { TodoIndex } from "../src/cache/index-do";

export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response("test stub");
  },
};
