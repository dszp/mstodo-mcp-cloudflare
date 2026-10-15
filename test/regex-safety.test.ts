import { describe, it, expect } from "vitest";
import { patternProblem, MAX_PATTERN_LENGTH } from "../src/config/regex-safety";

describe("patternProblem", () => {
  it.each([
    ["^PERSONAL$", "i"],
    ["\\b(?:INC|REQ)\\d{6,8}\\b", ""],
    ["T(\\d+)", ""],
    ["https?://[^\\s)]+", ""],
    ["(foo|bar)+", ""],
    ["[(+*)]+", ""],
    ["\\(a+\\)+", ""],
    // Link-rule shapes in real use (Autotask ticket numbers, note permalinks).
    ["(T\\d{8}\\.\\d{4}(?:\\.\\d{3})?)", ""],
    ["https://o\\.example\\.app/n/([A-Za-z0-9_-]{21})\\?f=([a-z0-9-]+)", ""],
    ["https://o\\.example\\.app/n/([A-Za-z0-9_-]{21})(?!\\?f=)", ""],
    ["https://r\\.example\\.com/n/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", ""],
    ["^ARCHIVED\\s+LEAD\\s+TEAM$", "i"],
  ])("accepts %s", (pattern, flags) => {
    expect(patternProblem(pattern, flags)).toBeNull();
  });

  it.each([
    ["(a+)+$"],
    ["(\\w*)*x"],
    ["((ab)+c)*"],
    ["(?:x{2,})+"],
    ["(a+){2,5}"],
  ])("refuses nested quantifier %s", (pattern) => {
    expect(patternProblem(pattern, "")).toMatch(/repeated group/);
  });

  it("refuses an invalid pattern", () => {
    expect(patternProblem("(unclosed", "")).not.toBeNull();
  });

  it("refuses an overlong pattern", () => {
    expect(patternProblem("a".repeat(MAX_PATTERN_LENGTH + 1), "")).toMatch(/longer than/);
  });
});
