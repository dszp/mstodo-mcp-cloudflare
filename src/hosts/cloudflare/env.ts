import type { AppEnv, IndexBackend } from "../../core/ports";
import { OWNER_DO_NAME } from "../../core/index/sql";

// Every Cloudflare entry point (Worker fetch/scheduled, the TodoIndex DO, the
// MCP agent, the OAuth callbacks) wraps its raw Env with this before handing it
// to core. It adds the one thing core cannot build itself: how to reach the
// singleton index, here the TodoIndex Durable Object addressed by name.
export function appEnv(env: Env): AppEnv {
  // The IndexBackend annotation (no cast) is what checks at compile time that the
  // TodoIndex RPC stub matches the surface core calls.
  return { ...env, ownerIndex: (): IndexBackend => env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName(OWNER_DO_NAME)) };
}
