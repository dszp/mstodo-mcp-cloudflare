/// <reference types="vite/client" />
// test/core-boundary.test.ts — reads source as text (bundled via ?raw like test/html.test.ts does)
import { describe, it, expect } from "vitest";
const files = import.meta.glob("../../../packages/core/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

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

// The glob keys are paths relative to this test file, so every core source's
// key starts with CORE. A relative specifier is resolved against its importer's
// key; one that lands outside CORE reaches into a worker, a script or anything
// else in the repository, which core must not depend on.
const CORE = "../../../packages/core/";

// The one file outside core that core may read: the root package.json, which
// version.ts reads for the release version. It is JSON data, not code.
const ALLOWED_OUTSIDE = new Set(["../../../package.json"]);

function escapesCore(importer: string, spec: string): boolean {
  if (!spec.startsWith(".")) return false; // a package name; FORBIDDEN judges it
  const parts = importer.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") {
      if (parts.length === 0 || parts[parts.length - 1] === "..") parts.push("..");
      else parts.pop();
    } else if (seg !== "." && seg !== "") parts.push(seg);
  }
  const resolved = parts.join("/");
  return !ALLOWED_OUTSIDE.has(resolved) && !`${resolved}/`.startsWith(CORE);
}

describe("core import boundary", () => {
  it("the glob finds the core sources (guards against a vacuous pass)", () => {
    expect(Object.keys(files).length).toBeGreaterThan(40);
    for (const key of Object.keys(files)) expect(key.startsWith(CORE), key).toBe(true);
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

  it("refuses a relative import that leaves packages/core (guards the resolver)", () => {
    const importer = `${CORE}sync/feed.ts`;
    for (const spec of ["../../workers/web/src/sync/store", "../../../scripts/deployment/x", "../../core-evil/x", "../../server/src/x", "../../package.json", "../../../package.ts"]) {
      expect(escapesCore(importer, spec), spec).toBe(true);
    }
    for (const spec of ["./feed-types", "../util/dates", "../../core/util/dates", "../../../package.json", "zod"]) {
      expect(escapesCore(importer, spec), spec).toBe(false);
    }
  });

  it.each(Object.entries(files))("%s imports nothing host-specific", (_path, src) => {
    for (const spec of specifiers(src)) {
      expect(spec, spec).not.toMatch(FORBIDDEN);
      expect(escapesCore(_path, spec), `${spec} resolves outside packages/core`).toBe(false);
    }
    expect(src).not.toMatch(/\bDurableObject(State|Namespace|Stub)\b|\bKVNamespace\b|\bSqlStorage\b/);
  });
});
