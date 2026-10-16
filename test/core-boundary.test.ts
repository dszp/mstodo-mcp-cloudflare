/// <reference types="vite/client" />
// test/core-boundary.test.ts — reads source as text (bundled via ?raw like test/html.test.ts does)
import { describe, it, expect } from "vitest";
const files = import.meta.glob("../src/core/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("core import boundary", () => {
  it("the glob finds the core sources (guards against a vacuous pass)", () => {
    expect(Object.keys(files).length).toBeGreaterThan(40);
  });

  it.each(Object.entries(files))("%s imports nothing host-specific", (_path, src) => {
    expect(src).not.toMatch(/from\s+["'](cloudflare:|agents|@cloudflare\/)/);
    expect(src).not.toMatch(/from\s+["'][^"']*hosts\//);
    expect(src).not.toMatch(/\bDurableObject(State|Namespace|Stub)\b|\bKVNamespace\b|\bSqlStorage\b/);
  });
});
