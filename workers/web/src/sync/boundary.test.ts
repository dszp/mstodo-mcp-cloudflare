/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// The sync engine must stay framework-free and host-free: no React, no server
// code, no Workers runtime. Core may be imported for types only, so the web
// bundle never pulls core runtime code.
const files = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FORBIDDEN = /^(react|react-dom)(\/|$)|workers\/server|^cloudflare:/;

/** Every import/export statement with a `from` clause, plus bare and dynamic imports. */
function statements(src: string): { text: string; specifier: string; typeOnly: boolean }[] {
  const out: { text: string; specifier: string; typeOnly: boolean }[] = [];
  const re = /\b(import|export)\b(\s+type\b)?[^;'"]*?\bfrom\s*(["'])([^"']+)\3|\bimport\s*\(\s*(["'])([^"']+)\5\s*\)|\bimport\s+(["'])([^"']+)\7/g;
  for (const m of src.matchAll(re)) {
    const specifier = m[4] ?? m[6] ?? m[8];
    out.push({ text: m[0], specifier, typeOnly: m[2] !== undefined });
  }
  return out;
}

describe("sync engine boundary", () => {
  it("finds engine files", () => {
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(1);
  });

  for (const [path, src] of Object.entries(files)) {
    it(`${path} imports nothing forbidden`, () => {
      const bad = statements(src).filter((s) => FORBIDDEN.test(s.specifier));
      expect(bad.map((s) => s.specifier)).toEqual([]);
    });

    it(`${path} imports @potem/core for types only`, () => {
      const bad = statements(src).filter((s) => s.specifier.startsWith("@potem/core/") && !s.typeOnly);
      expect(bad.map((s) => s.text)).toEqual([]);
    });
  }
});
