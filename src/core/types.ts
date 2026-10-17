// Stored (encrypted) in each MCP grant when authorization completes; the host
// hands it back as the grant props on every request. `epoch` and
// `authorized_at` are checked on every /mcp request and every refresh — see
// grantRefusal() in core/auth/grant.ts.
export interface Props extends Record<string, unknown> {
  user: string;
  epoch: string;
  authorized_at: number; // epoch ms
}
