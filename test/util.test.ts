import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { stripHtml } from "../src/util/html";
import { parseDateInput } from "../src/util/dates";
import { encodeCursor, decodeCursor } from "../src/util/cursor";

describe("stripHtml", () => {
  it("strips tags and decodes entities for html content", () => {
    expect(stripHtml("<p>a&amp;b</p>", "html")).toBe("a&b");
  });

  it("decodes common and numeric entities", () => {
    expect(stripHtml("<b>x</b> &lt;y&gt; &#39;z&#39; &quot;q&quot;", "html")).toBe(
      "x <y> 'z' \"q\"",
    );
  });

  it("passes text content through unchanged", () => {
    expect(stripHtml("<p>a&amp;b</p>", "text")).toBe("<p>a&amp;b</p>");
  });

  it("treats an absent contentType as plain text (passthrough)", () => {
    expect(stripHtml("<p>a&amp;b</p>")).toBe("<p>a&amp;b</p>");
  });
});

describe("parseDateInput", () => {
  const FIXED = Date.parse("2026-05-24T00:00:00Z");
  const DAY = 86_400_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses an ISO date to epoch ms", () => {
    expect(parseDateInput("2026-06-01")).toBe(Date.parse("2026-06-01"));
  });

  it("parses a positive relative offset against now", () => {
    expect(parseDateInput("+7d")).toBe(FIXED + 7 * DAY);
  });

  it("parses a negative relative offset against now", () => {
    expect(parseDateInput("-30d")).toBe(FIXED - 30 * DAY);
  });

  it("returns null for unparseable input", () => {
    expect(parseDateInput("garbage")).toBeNull();
    expect(parseDateInput("")).toBeNull();
  });
});

describe("cursor", () => {
  it("round-trips modified_at + task_id", () => {
    const c = { modified_at: 1_700_000_000_000, task_id: "AAMk-abc_123" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("round-trips a null modified_at", () => {
    const c = { modified_at: null, task_id: "t1" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("returns null for a malformed cursor", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });
});
