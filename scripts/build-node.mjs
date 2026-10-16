// Bundles the Node host into dist/main.mjs.
//
// esbuild rather than tsc: the source uses extensionless imports
// (moduleResolution: bundler), which Node's ESM loader rejects.
//
// Runtime dependencies stay external (installed by `npm ci --omit=dev`), except
// @cloudflare/workers-oauth-provider: it imports `cloudflare:workers`, which
// only exists on Workers, so it is bundled and that import is aliased to an
// empty stand-in. An alias only applies to code esbuild bundles, which is why
// the library cannot stay external.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const BUNDLED = new Set(["@cloudflare/workers-oauth-provider"]);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies ?? {})
  .filter((name) => !BUNDLED.has(name))
  .flatMap((name) => [name, `${name}/*`]);

await build({
  entryPoints: ["src/hosts/node/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/main.mjs",
  external,
  alias: { "cloudflare:workers": "./src/hosts/node/cloudflare-workers-shim.ts" },
  logLevel: "info",
});
