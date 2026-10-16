// Ambient declaration for Vite `?raw` imports, which return a file's text content
// as a string. Used by tool-annotations.test.ts to statically scan
// src/core/mcp/register-tools.ts without importing the module (it pulls in the
// MCP SDK and ajv, which the workers test pool can't resolve).
declare module "*?raw" {
  const content: string;
  export default content;
}
