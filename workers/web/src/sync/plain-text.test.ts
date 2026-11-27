import { describe, expect, it } from "vitest";
import { bodyText } from "./plain-text";

// A copy of SHARED_CASES in workers/server/test/html.test.ts, which pins core's
// stripHtml to the same outputs. The engine may not import core's runtime code,
// so the two implementations are held together by these cases: change both.
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

describe("bodyText", () => {
  it.each(SHARED_CASES)("shared case %#: %j", (input, expected) => {
    expect(bodyText({ type: "html", content: input })).toBe(expected);
  });

  it("returns a text body as it is", () => {
    expect(bodyText({ type: "text", content: "a <b>  &amp; c" })).toBe("a <b>  &amp; c");
  });

  it("returns an empty string for no body", () => {
    expect(bodyText(null)).toBe("");
  });

  it("strips script and style in any letter case and to the end when unclosed", () => {
    expect(bodyText({ type: "html", content: "a<SCRIPT type=x>var div = 1;</Script >b" })).toBe("a b");
    expect(bodyText({ type: "html", content: "<styles>x</styles>y" })).toBe("x y");
    expect(bodyText({ type: "html", content: "a<style>never closed" })).toBe("a");
  });

  it("is linear on unclosed '<' runs", () => {
    const evil = "<".repeat(200000);
    expect(bodyText({ type: "html", content: evil })).toBe(evil);
  });
});
