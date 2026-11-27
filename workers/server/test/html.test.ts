import { describe, it, expect } from "vitest";
import { stripHtml } from "@potem/core/util/html";

const SHARED_CASES: [string, string][] = [
  ["<p>hello</p>", "hello"],
  ["a<b>c</b>d", "a c d"],
  ["x&amp;y &lt;z&gt; &quot;q&quot; &#39;s&apos; a&nbsp;b", "x&y <z> \"q\" 's' a b"],
  ["&#65;&#x42;&#X43;", "ABC"],
  ["&copy; &unknown; &#99999999;", "&copy; &unknown; &#99999999;"],
  ["<div><a href=\"https://example.com/x\">link</a></div>", "link"],
  ["<html><head><style>.div { href: 1 }</style></head><body>ham<b>mer</b></body></html>", "ham mer"],
  ["<script>alert(1)</script>after", "after"],
  ["  many \n\t spaces  ", "many spaces"],
  ["done <not a tag", "done <not a tag"],
  ["<a<b>x", "x"],
];

describe("stripHtml", () => {
  it("passes non-html content through verbatim", () => {
    expect(stripHtml("a < b & c", "text")).toBe("a < b & c");
    expect(stripHtml("plain", undefined)).toBe("plain");
  });

  it("strips tags to spaces, decodes entities, collapses whitespace", () => {
    expect(stripHtml("<p>hello</p>", "html")).toBe("hello");
    expect(stripHtml("a<b>c</b>d", "html")).toBe("a c d");
    expect(stripHtml("x&amp;y &lt;z&gt;", "html")).toBe("x&y <z>");
    expect(stripHtml("&#65;&#x42;", "html")).toBe("AB");
  });

  it("treats a nested/malformed '<' inside a tag as one stripped run", () => {
    expect(stripHtml("<a<b>x", "html")).toBe("x");
  });

  it("leaves a trailing unclosed '<' (no closing '>') in place", () => {
    expect(stripHtml("done <not a tag", "html")).toBe("done <not a tag");
  });

  it("handles pathological unclosed-'<' input without quadratic blowup", () => {
    // The old /<[^>]*>/g would be O(n²) here and time the test out; the linear
    // strip returns instantly. No complete tag → nothing stripped.
    const evil = "<".repeat(200000);
    expect(stripHtml(evil, "html")).toBe(evil);
  });

  it("drops the contents of script and style elements", () => {
    expect(stripHtml("<style>p { color: red }</style><p>keep</p>", "html")).toBe("keep");
    expect(stripHtml("a<SCRIPT type=x>var div = 1;</Script >b", "html")).toBe("a b");
    expect(stripHtml("<styles>x</styles>y", "html")).toBe("x y");
    expect(stripHtml("a<style>never closed", "html")).toBe("a");
  });

  it("leaves a numeric entity outside Unicode in place instead of throwing", () => {
    expect(stripHtml("x&#99999999;y &#x110000;", "html")).toBe("x&#99999999;y &#x110000;");
  });

  // The web client's search applies the same rule (docs/SYNC-API.md 4.10);
  // workers/web/src/sync/plain-text.test.ts holds a copy of these cases.
  it.each(SHARED_CASES)("shared case %#: %j", (input, expected) => {
    expect(stripHtml(input, "html")).toBe(expected);
  });
});
