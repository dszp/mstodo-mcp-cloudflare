import { build } from "vite";
import { expect, it } from "vitest";

// The Worker's CSP is script-src 'self'; style-src 'self': an inline script or
// style in the built page would be blocked at runtime. Builds in memory.
it("builds an index.html with no inline script or style", async () => {
  const out = await build({
    configFile: new URL("./vite.config.ts", import.meta.url).pathname,
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => ("output" in o ? o.output : []));
  const page = outputs.find((o) => o.fileName === "index.html");
  expect(page?.type).toBe("asset");
  const html = String((page as { source: string | Uint8Array }).source);
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]!);
  expect(scripts.length).toBeGreaterThan(0);
  for (const attrs of scripts) expect(attrs).toMatch(/\bsrc=/);
  expect(html).not.toMatch(/<style\b/i);
  expect(html).not.toMatch(/\son[a-z]+=/i);
  expect(html).not.toMatch(/\sstyle=/i);
});
