/// <reference types="vite/client" />
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The sync engine must stay framework-free and host-free: no React, no server
// code, no Workers runtime, and no files outside its own directory. Core may be
// imported for types only, so the web bundle never pulls core runtime code.
const SYNC_DIR = "workers/web/src/sync";

const files = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface Ref {
  specifier: string | null; // null: not a string literal, cannot be checked
  typeOnly: boolean;
}

function references(fileName: string, src: string): Ref[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Ref[] = [];
  const lit = (n: ts.Node | undefined) => (n && ts.isStringLiteralLike(n) ? n.text : null);
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      out.push({ specifier: lit(n.moduleSpecifier), typeOnly: n.importClause?.isTypeOnly === true });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      out.push({ specifier: lit(n.moduleSpecifier), typeOnly: n.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      out.push({ specifier: lit(n.moduleReference.expression), typeOnly: n.isTypeOnly });
    } else if (ts.isImportTypeNode(n)) {
      const arg = n.argument;
      out.push({ specifier: ts.isLiteralTypeNode(arg) ? lit(arg.literal) : null, typeOnly: true });
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === "require"))
    ) {
      out.push({ specifier: lit(n.arguments[0]), typeOnly: false });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Violations for one file. `file` is relative to the sync directory, e.g. "./feed.ts". */
export function violations(file: string, src: string): string[] {
  // URL resolution gives POSIX path semantics without needing Node types.
  const base = new URL(file, `file:///${SYNC_DIR}/`);
  const bad: string[] = [];
  for (const { specifier, typeOnly } of references(file, src)) {
    if (specifier === null) {
      bad.push("non-literal module specifier");
    } else if (/^(react|react-dom)(\/|$)/.test(specifier) || specifier.startsWith("cloudflare:")) {
      bad.push(specifier);
    } else if (specifier === "@potem/core" || specifier.startsWith("@potem/core/")) {
      if (!typeOnly) bad.push(`${specifier} (value import)`);
    } else if (specifier.startsWith(".")) {
      const resolved = new URL(specifier, base).pathname.slice(1);
      if (resolved !== SYNC_DIR && !resolved.startsWith(`${SYNC_DIR}/`)) bad.push(`${specifier} (leaves ${SYNC_DIR})`);
    } else if (/workers\/server/.test(specifier)) {
      bad.push(specifier);
    }
  }
  return bad;
}

describe("boundary checker", () => {
  const cases: { label: string; src: string; bad: boolean }[] = [
    { label: "react import", src: `import { useState } from "react";`, bad: true },
    { label: "react subpath", src: `import x from "react-dom/client";`, bad: true },
    { label: "cloudflare:", src: `import { env } from "cloudflare:workers";`, bad: true },
    { label: "workers/server specifier", src: `import x from "workers/server/src/x";`, bad: true },
    { label: "relative into workers/server", src: `import x from "../../../server/src/x";`, bad: true },
    { label: "relative into packages/core", src: `import x from "../../../../packages/core/index/change-feed";`, bad: true },
    { label: "relative to web src sibling dir", src: `import x from "../ui/thing";`, bad: true },
    { label: "bare @potem/core value import", src: `import { x } from "@potem/core";`, bad: true },
    { label: "@potem/core value import", src: `import { x } from "@potem/core/index/change-feed";`, bad: true },
    { label: "@potem/core inline type specifier", src: `import { type A } from "@potem/core/x";`, bad: true },
    { label: "@potem/core side-effect import", src: `import "@potem/core/x";`, bad: true },
    { label: "@potem/core export value", src: `export { a } from "@potem/core/x";`, bad: true },
    { label: "require react", src: `const r = require("react");`, bad: true },
    { label: "dynamic import react", src: `const r = await import("react");`, bad: true },
    { label: "dynamic non-literal", src: `const r = await import(name);`, bad: true },
    {
      label: "type decl without semicolon followed by value import",
      src: `export type Foo = { a: string }\nimport { y } from "@potem/core/x"`,
      bad: true,
    },
    { label: "import type from core", src: `import type { A } from "@potem/core/x";`, bad: false },
    { label: "bare import type from core", src: `import type { A } from "@potem/core";`, bad: false },
    { label: "export type from core", src: `export type { A } from "@potem/core/x";`, bad: false },
    { label: "inline import() type", src: `type T = import("@potem/core/x").A;`, bad: false },
    { label: "sibling import", src: `import { a } from "./other";`, bad: false },
    { label: "sibling subdirectory", src: `import { a } from "./sub/other";`, bad: false },
    { label: "no imports", src: `export const x = 1;`, bad: false },
  ];
  for (const c of cases) {
    it(`${c.bad ? "rejects" : "accepts"}: ${c.label}`, () => {
      expect(violations("./snippet.ts", c.src).length > 0).toBe(c.bad);
    });
  }
  it("resolves relative specifiers from the file's own directory", () => {
    expect(violations("./sub/a.ts", `import x from "../b";`)).toEqual([]);
    expect(violations("./sub/a.ts", `import x from "../../c";`)).toHaveLength(1);
  });
});

describe("sync engine boundary", () => {
  it("finds engine files", () => {
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(1);
  });

  for (const [path, src] of Object.entries(files)) {
    it(`${path} respects the boundary`, () => {
      expect(violations(path, src)).toEqual([]);
    });
  }
});
