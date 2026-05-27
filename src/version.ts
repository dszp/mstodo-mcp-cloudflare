// Single source of truth for the server version. Read from package.json at
// build time (resolveJsonModule) so /health and the MCP server name can never
// drift from the released version — bump package.json and both pick it up.
import pkg from "../package.json";

export const VERSION: string = pkg.version;
