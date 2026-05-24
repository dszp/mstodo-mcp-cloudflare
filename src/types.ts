import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// Bindings declared in wrangler.jsonc (KV namespaces, durable_objects, vars)
// are emitted into worker-configuration.d.ts by `wrangler types` and merge
// into the global Env. Only declare here what wrangler does NOT know about:
//   - OAUTH_PROVIDER — injected by the OAuthProvider runtime
//   - Secrets without defaults — set via `wrangler secret put` or `.dev.vars`
//
// The secrets must land on BOTH `Env` (global, used by Worker code) and
// `Cloudflare.Env` (the namespace `cloudflare:test` types `env` as). Locally
// `wrangler types` reads `.dev.vars` and bakes them into both via the generated
// base interface, but CI has no `.dev.vars`, so we declare them explicitly here.
interface OwnerSecrets {
  // Microsoft Entra app credentials + owner identity gate
  MS_TENANT_ID: string;
  MS_CLIENT_ID: string;
  MS_CLIENT_SECRET: string;
  OWNER_EMAIL: string;
}

declare global {
  interface Env extends OwnerSecrets {
    OAUTH_PROVIDER: OAuthHelpers;
  }
  namespace Cloudflare {
    interface Env extends OwnerSecrets {}
  }
}

export interface Props extends Record<string, unknown> {
  user: string;
}

export {};
