import { env } from "cloudflare:test";
import { appEnv } from "../src/hosts/cloudflare/env";
import type { AppEnv } from "../src/core/ports";

// The cloudflare:test env wrapped the way every Cloudflare entry point wraps
// its Env before calling core: same bindings, plus ownerIndex → the TodoIndex
// Durable Object stub. Pass this, not the raw env, to core functions.
export function testAppEnv(): AppEnv {
  return appEnv(env as unknown as Env);
}
