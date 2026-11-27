import { describe, expect, it } from "vitest";
import { findLeaks, formatLeak, parsePatterns, pushRanges } from "../scripts/leak-guard.ts";

describe("parsePatterns", () => {
  it("keeps one lowercased term per line and skips blanks and comments", () => {
    expect(parsePatterns("# hosts\nAcme.Example\n\n  Secret Co  \n#x\n")).toEqual(["acme.example", "secret co"]);
  });
});

describe("findLeaks", () => {
  const patterns = ["acme.example", "secret co"];

  it("reports each matching line with its source, line number and pattern number", () => {
    const leaks = findLeaks(
      [
        { label: "a.md", text: "fine\nsee ACME.example here\n" },
        { label: "b.ts", text: "nothing" },
        { label: "commit abc1234", text: "Fix for Secret Co\n\nbody" },
      ],
      patterns,
    );
    expect(leaks).toEqual([
      { label: "a.md", line: 2, pattern: 1, text: "see ACME.example here" },
      { label: "commit abc1234", line: 1, pattern: 2, text: "Fix for Secret Co" },
    ]);
  });

  it("matches a term written as an escaped regex", () => {
    const leaks = findLeaks([{ label: "t.ts", text: 'pattern: "https://acme\\\\.example/n/"' }], patterns);
    expect(leaks.map((l) => l.pattern)).toEqual([1]);
  });

  it("finds nothing with no patterns", () => {
    expect(findLeaks([{ label: "a", text: "anything" }], [])).toEqual([]);
  });
});

describe("formatLeak", () => {
  const leak = { label: "a.md", line: 2, pattern: 1, text: "see acme.example here" };

  it("shows the line locally", () => {
    expect(formatLeak(leak, false)).toBe("a.md:2: pattern #1: see acme.example here");
  });

  it("redacts the line and the term in CI, whose logs are public", () => {
    expect(formatLeak(leak, true)).toBe("a.md:2: pattern #1");
  });
});

describe("pushRanges", () => {
  const zero = "0".repeat(40);
  const a = "a".repeat(40);
  const b = "b".repeat(40);

  it("checks the commits new to an existing remote branch", () => {
    expect(pushRanges(`refs/heads/x ${b} refs/heads/x ${a}\n`)).toEqual([{ tip: b, range: [`${a}..${b}`] }]);
  });

  it("checks the commits no remote has for a new branch", () => {
    expect(pushRanges(`refs/heads/x ${b} refs/heads/x ${zero}\n`)).toEqual([{ tip: b, range: [b, "--not", "--remotes"] }]);
  });

  it("skips a branch deletion", () => {
    expect(pushRanges(`(delete) ${zero} refs/heads/x ${a}\n`)).toEqual([]);
  });
});
