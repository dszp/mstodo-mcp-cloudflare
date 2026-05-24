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
    },
  },
};

export default defineConfig({
  plugins: [cloudflareTest(poolOptions)],
  test: {
    pool: cloudflarePool(poolOptions),
  },
});
