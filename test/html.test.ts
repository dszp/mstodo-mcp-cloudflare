import { describe, it, expect } from "vitest";
import { stripHtml } from "../src/util/html";

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
});
