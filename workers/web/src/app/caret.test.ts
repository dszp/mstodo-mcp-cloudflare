import { describe, expect, it } from "vitest";
import { caretFromClick, caretIndex } from "./caret.ts";

describe("caretIndex", () => {
  it("puts the caret at the end when there is no click point", () => {
    expect(caretIndex(null, 12)).toBe(12);
  });
  it("keeps a click point inside the text", () => {
    expect(caretIndex(5, 12)).toBe(5);
  });
  it("clamps a point past either end", () => {
    expect(caretIndex(40, 12)).toBe(12);
    expect(caretIndex(-3, 12)).toBe(0);
  });
  it("treats a non-number as the end", () => {
    expect(caretIndex(Number.NaN, 12)).toBe(12);
  });
});

describe("caretFromClick", () => {
  it("returns null for a keyboard activation, without touching the document", () => {
    // detail 0 is how browsers mark a click made with Enter or Space.
    expect(caretFromClick({ clientX: 10, clientY: 10, detail: 0 }, {} as Element)).toBeNull();
  });
});
