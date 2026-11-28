import { describe, expect, it } from "vitest";
import { SMART_LISTS } from "@potem/core/index/feed-types";
import { type Route, formatRoute, parseRoute } from "./route.ts";

const parse = (path: string) => parseRoute(new URL(path, "https://web.example.com"));

describe("parseRoute / formatRoute", () => {
  const routes: Array<[string, Route]> = [
    ["/", { view: "smart", list: "my_day" }],
    ["/?task=t-1", { view: "smart", list: "my_day", task: "t-1" }],
    ...SMART_LISTS.filter((l) => l !== "my_day").map((l): [string, Route] => [`/smart/${l}`, { view: "smart", list: l }]),
    ["/smart/important?task=abc_DEF-9", { view: "smart", list: "important", task: "abc_DEF-9" }],
    ["/list/AAMkAD-x_1", { view: "list", id: "AAMkAD-x_1" }],
    ["/list/abc?task=t2", { view: "list", id: "abc", task: "t2" }],
    ["/search?q=milk", { view: "search", q: "milk", all: false }],
    ["/search?q=milk+and+eggs&all=1", { view: "search", q: "milk and eggs", all: true }],
    ["/search?q=caf%C3%A9+%26+50%25", { view: "search", q: "café & 50%", all: false }],
  ];

  for (const [path, route] of routes) {
    it(`parses ${path} and formats it back`, () => {
      expect(parse(path)).toEqual(route);
      expect(formatRoute(route)).toBe(path);
      expect(parse(formatRoute(route))).toEqual(route);
    });
  }

  it("parses /smart/my_day as My Day, which formats as /", () => {
    expect(parse("/smart/my_day")).toEqual({ view: "smart", list: "my_day" });
  });

  it("parses /search without q as an empty query", () => {
    expect(parse("/search")).toEqual({ view: "search", q: "", all: false });
  });

  it.each([
    "/smart/today",
    "/smart/My_Day",
    "/smart/",
    "/smart",
    "/smart/all/extra",
    "/list/",
    "/list/has.dot",
    "/list/has%20space",
    `/list/${"a".repeat(129)}`,
    "/list/a/b",
    "/list/a?task=bad.id",
    "/?task=",
    "/nowhere",
    "/list/a/",
  ])("rejects %s", (path) => {
    expect(parse(path)).toBeNull();
  });

  it("accepts a 128-character id", () => {
    const id = "a".repeat(128);
    expect(parse(`/list/${id}`)).toEqual({ view: "list", id });
  });
});
