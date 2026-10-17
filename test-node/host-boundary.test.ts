import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The Node host and the shared OAuth front must load on Node: neither may reach
// into the Cloudflare host (whose oauth.ts pulls in McpAgent → agents), and the
// shared front may not depend on either host.
const root = new URL("../src/hosts/", import.meta.url).pathname;
// Recursive, so a file in a subdirectory added later is still checked.
const sources = (dir: string) =>
  (readdirSync(join(root, dir), { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [`${dir}/${f}`, readFileSync(join(root, dir, f), "utf8")] as const);

// Static `from`, side-effect `import "x"` and dynamic `import("x")` specifiers.
const imports = (src: string) =>
  [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g].flatMap(
    (re) => [...src.matchAll(re)].map((m) => m[1]),
  );

describe("host import boundary", () => {
  const node = sources("node");
  const shared = sources("shared");

  it("finds the sources (guards against a vacuous pass)", () => {
    expect(node.map(([p]) => p)).toEqual(expect.arrayContaining(["node/http.ts", "node/env.ts", "node/main.ts"]));
    expect(shared.map(([p]) => p)).toEqual(expect.arrayContaining(["shared/oauth.ts", "shared/auth-handler.ts"]));
  });

  it("reads subdirectories and every import form (guards the helpers)", () => {
    expect(imports('import "x"; await import("y"); export { z } from "z";').sort()).toEqual(["x", "y", "z"]);
    const nested = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    expect(nested.length).toBeGreaterThanOrEqual(node.length + shared.length);
  });

  it.each(node)("%s imports nothing from the Cloudflare host", (_p, src) => {
    for (const spec of imports(src)) expect(spec).not.toMatch(/(^|\/)cloudflare\/|^agents/);
  });

  it.each(shared)("%s imports neither host", (_p, src) => {
    for (const spec of imports(src)) expect(spec).not.toMatch(/(^|\/)(cloudflare|node)\/|^agents|^cloudflare:/);
  });
});
