import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

const poolOptions = {
  main: "test/_test-worker.ts",
  // Use the committed example config so `npm test` runs on a fresh clone without
  // the gitignored real wrangler.jsonc. miniflare ignores account_id / KV IDs
  // (it simulates bindings locally), so the placeholders are fine for tests.
  wrangler: { configPath: "./wrangler.example.jsonc" },
  miniflare: {
    kvNamespaces: ["OAUTH_KV", "TODO_CACHE"],
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      TIMEZONE: "America/New_York",
      DELTA_SYNC_INTERVAL_MIN: "15",
      LIST_METADATA_SOFT_TTL_SEC: "900",
      OWNER_EMAIL: "test-owner@example.com",
      MS_TENANT_ID: "test-tenant",
      MS_CLIENT_ID: "test-client",
      MS_CLIENT_SECRET: "test-secret",
      SERVICE_BASE_URL: "https://mstodo-mcp.example.workers.dev",
      ENABLE_TASK_SUBSCRIPTIONS: "true",
      ENABLE_CHECKLIST_CACHE: "true",
      ENABLE_MY_DAY: "true",
    },
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest(poolOptions)],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts"],
          pool: cloudflarePool(poolOptions),
        },
      },
      {
        test: {
          name: "node",
          include: ["test-node/**/*.test.ts"],
          environment: "node",
          pool: "forks",
          // node_modules are externalized (loaded by Node, not Vite), which
          // would bypass the alias below; inline the OAuth library so its
          // `cloudflare:workers` import goes through it.
          server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
        },
        resolve: {
          alias: {
            "cloudflare:workers": new URL("./src/hosts/node/cloudflare-workers-shim.ts", import.meta.url).pathname,
          },
        },
      },
    ],
  },
});
