// Ambient declaration for Vite `?raw` imports, which return a file's text content
// as a string. Used by tool-annotations.test.ts to statically scan agent.ts's
// source without importing the module (the MCP agent pulls in ajv, which the
// workers test pool can't resolve).
declare module "*?raw" {
  const content: string;
  export default content;
}
