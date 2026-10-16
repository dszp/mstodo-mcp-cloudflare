/// <reference types="vite/client" />
// test/core-boundary.test.ts — reads source as text (bundled via ?raw like test/html.test.ts does)
import { describe, it, expect } from "vitest";
const files = import.meta.glob("../src/core/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// Every module specifier a source names: `import … from "x"`, `export … from
// "x"`, side-effect `import "x"`, and dynamic `import("x")`.
function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const re of [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
}

const FORBIDDEN = /^(cloudflare:|agents(\/|$)|@cloudflare\/)|(^|\/)hosts\//;

describe("core import boundary", () => {
  it("the glob finds the core sources (guards against a vacuous pass)", () => {
    expect(Object.keys(files).length).toBeGreaterThan(40);
  });

  it("finds every import form (guards the extractor)", () => {
    const sample = [
      'import { a } from "cloudflare:workers";',
      'export { b } from "../hosts/node/env";',
      'import "agents";',
      'const m = await import("@cloudflare/workers-oauth-provider");',
      "const n = await import ( '../../hosts/cloudflare/env' );",
    ].join("\n");
    const found = specifiers(sample);
    expect(found).toHaveLength(5);
    for (const spec of found) expect(spec).toMatch(FORBIDDEN);
  });

  it.each(Object.entries(files))("%s imports nothing host-specific", (_path, src) => {
    for (const spec of specifiers(src)) expect(spec, spec).not.toMatch(FORBIDDEN);
    expect(src).not.toMatch(/\bDurableObject(State|Namespace|Stub)\b|\bKVNamespace\b|\bSqlStorage\b/);
  });
});
