import type { AppEnv, IndexBackend } from "./ports";

// The one place core resolves the singleton index. Each host supplies
// env.ownerIndex: Node returns the in-process IndexCore, Cloudflare returns an
// RPC stub to the TodoIndex Durable Object (src/hosts/cloudflare/env.ts).
export function ownerIndex(env: AppEnv): IndexBackend {
  return env.ownerIndex();
}
