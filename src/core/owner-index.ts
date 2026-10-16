import type { AppEnv, IndexBackend } from "./ports";
import { OWNER_DO_NAME } from "../cache/sql";

// The one place core resolves the singleton index. A host either supplies
// env.ownerIndex (Node: the in-process IndexCore) or exposes the Cloudflare
// Durable Object namespace as TODO_INDEX_DO. This fallback is the only
// Cloudflare-shaped code core keeps, and it moves to the Cloudflare host in
// Task 7 once every entry point sets env.ownerIndex.
export function ownerIndex(env: AppEnv): IndexBackend {
  if (env.ownerIndex) return env.ownerIndex();
  const ns = (env as unknown as { TODO_INDEX_DO: DurableObjectNamespace<import("../cache/index-do").TodoIndex> }).TODO_INDEX_DO;
  return ns.get(ns.idFromName(OWNER_DO_NAME)) as unknown as IndexBackend;
}
