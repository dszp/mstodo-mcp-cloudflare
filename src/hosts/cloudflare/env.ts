import type { AppEnv } from "../../core/ports";
import { OWNER_DO_NAME } from "../../core/index/sql";

// Every Cloudflare entry point (Worker fetch/scheduled, the TodoIndex DO, the
// MCP agent, the OAuth callbacks) wraps its raw Env with this before handing it
// to core. It adds the one thing core cannot build itself: how to reach the
// singleton index, here the TodoIndex Durable Object addressed by name.
export function appEnv(env: Env): AppEnv {
  return { ...env, ownerIndex: () => env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName(OWNER_DO_NAME)) as never };
}
