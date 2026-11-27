// Entry worker for @cloudflare/vitest-plugin. The pool instantiates DO
// classes from this module lazily (only when a test addresses the binding), so
// we re-export TodoIndex here. MSToDoSession is intentionally NOT re-exported: it
// pulls in the MCP SDK → ajv, which the workers pool can't resolve, and no DO
// test instantiates the MCP_SESSION (agent) binding.
export { TodoIndex } from "../src/hosts/cloudflare/todo-index-do";

export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response("test stub");
  },
};
