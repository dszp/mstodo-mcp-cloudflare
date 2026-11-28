import { build } from "vite";
import { expect, it } from "vitest";
import { DATA_KEY as FAKE_DATA_KEY } from "./src/app/dev/fake-bff.ts";

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

// The dev server's fake BFF (src/app/dev/fake-bff.ts) answers "signed in" to
// anyone; nothing of it may reach a build.
it("leaves the fake BFF out of the build", async () => {
  const out = await build({
    configFile: new URL("./vite.config.ts", import.meta.url).pathname,
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => ("output" in o ? o.output : []));
  expect(outputs.length).toBeGreaterThan(0);
  for (const o of outputs) {
    const text = o.type === "chunk" ? o.code : String(typeof o.source === "string" ? o.source : new TextDecoder().decode(o.source));
    expect(text, o.fileName).not.toContain("potem-fake-bff");
    expect(text, o.fileName).not.toContain(FAKE_DATA_KEY);
  }
});
