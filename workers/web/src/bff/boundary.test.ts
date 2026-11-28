/// <reference types="vite/client" />
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The BFF is host-independent: it runs on Workers today and must run on Node
// (and in tests) unchanged. It imports nothing Cloudflare-only, nothing from the
// host or the React app, and touches no browser global.
const BFF_DIR = "workers/web/src/bff";
const FORBIDDEN_GLOBALS = new Set(["document", "window", "localStorage", "sessionStorage"]);

const files = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Violations for one file. `file` is relative to the BFF directory, e.g. "./api.ts". */
export function violations(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const base = new URL(file, `file:///${BFF_DIR}/`);
  const bad: string[] = [];
  const checkSpecifier = (node: ts.Node | undefined) => {
    if (!node || !ts.isStringLiteralLike(node)) {
      bad.push("non-literal module specifier");
      return;
    }
    const s = node.text;
    if (/^(react|react-dom)(\/|$)/.test(s) || s.startsWith("cloudflare:")) bad.push(s);
    else if (s.startsWith(".")) {
      const resolved = new URL(s, base).pathname.slice(1);
      if (/^workers\/web\/src\/(hosts|app)(\/|$)/.test(resolved)) bad.push(`${s} (reaches ${resolved})`);
      else if (!resolved.startsWith(`${BFF_DIR}/`)) bad.push(`${s} (leaves ${BFF_DIR})`);
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) checkSpecifier(n.moduleSpecifier);
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier) checkSpecifier(n.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      checkSpecifier(n.moduleReference.expression);
    } else if (ts.isImportTypeNode(n)) {
      checkSpecifier(ts.isLiteralTypeNode(n.argument) ? n.argument.literal : undefined);
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))
    ) {
      checkSpecifier(n.arguments[0]);
    } else if (ts.isIdentifier(n) && FORBIDDEN_GLOBALS.has(n.text)) {
      // A property or member name (res.document) is not the global.
      const p = n.parent;
      const member = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n);
      if (!member) bad.push(`global ${n.text}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}

describe("boundary checker", () => {
  const cases: { label: string; src: string; bad: boolean }[] = [
    { label: "react import", src: `import { useState } from "react";`, bad: true },
    { label: "react-dom subpath", src: `import x from "react-dom/client";`, bad: true },
    { label: "cloudflare:", src: `import { env } from "cloudflare:workers";`, bad: true },
    { label: "host import", src: `import x from "../hosts/cloudflare/worker.ts";`, bad: true },
    { label: "app import", src: `import x from "../app/main.tsx";`, bad: true },
    { label: "app type import", src: `import type { X } from "../app/x.ts";`, bad: true },
    { label: "dynamic import of a host", src: `const m = await import("../hosts/cloudflare/worker.ts");`, bad: true },
    { label: "export from host", src: `export { a } from "../hosts/x.ts";`, bad: true },
    { label: "leaves the bff directory", src: `import x from "../sync/feed.ts";`, bad: true },
    { label: "dynamic non-literal", src: `const m = await import(name);`, bad: true },
    { label: "document", src: `const t = document.title;`, bad: true },
    { label: "window", src: `window.location.href = "/";`, bad: true },
    { label: "localStorage", src: `localStorage.setItem("a", "b");`, bad: true },
    { label: "globalThis-free window in typeof", src: `if (typeof window !== "undefined") {}`, bad: true },
    { label: "sibling import", src: `import { a } from "./other.ts";`, bad: false },
    { label: "member named document", src: `const d = res.document; const o = { window: 1 };`, bad: false },
    { label: "no imports", src: `export const x = 1;`, bad: false },
  ];
  for (const c of cases) {
    it(`${c.bad ? "rejects" : "accepts"}: ${c.label}`, () => {
      expect(violations("./snippet.ts", c.src).length > 0).toBe(c.bad);
    });
  }
});

describe("BFF boundary", () => {
  it("finds BFF files", () => {
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(1);
  });

  for (const [path, src] of Object.entries(files)) {
    it(`${path} respects the boundary`, () => {
      expect(violations(path, src)).toEqual([]);
    });
  }
});
