// /.well-known/apple-app-site-association (docs/SYNC-API.md section 8).
import { describe, it, expect, vi } from "vitest";
import { appleAppIds, handleAppleAssociation } from "@potem/core/auth/apple-association";
import { testAppEnv } from "./_app-env";

const URL_ = "https://mcp.test/.well-known/apple-app-site-association";
const on = { APPLE_TEAM_ID: "ABCDE12345", APPLE_BUNDLE_IDS: "com.example.todo, com.example.todo.mac" };

describe("Apple app site association", () => {
  it("is off without configuration", () => {
    expect(handleAppleAssociation(new Request(URL_), testAppEnv())).toBeNull();
  });

  it("serves webcredentials for each bundle ID as JSON, with no redirect", async () => {
    const res = handleAppleAssociation(new Request(URL_), { ...testAppEnv(), ...on })!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      webcredentials: { apps: ["ABCDE12345.com.example.todo", "ABCDE12345.com.example.todo.mac"] },
    });
  });

  it("answers HEAD without a body and ignores other paths and methods", async () => {
    const env = { ...testAppEnv(), ...on };
    const head = handleAppleAssociation(new Request(URL_, { method: "HEAD" }), env)!;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(handleAppleAssociation(new Request(URL_, { method: "POST" }), env)).toBeNull();
    expect(handleAppleAssociation(new Request("https://mcp.test/apple-app-site-association"), env)).toBeNull();
  });

  it("stays off when half or wrongly configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(appleAppIds({ APPLE_TEAM_ID: "ABCDE12345" })).toBeNull();
    expect(appleAppIds({ APPLE_BUNDLE_IDS: "com.example.todo" })).toBeNull();
    expect(appleAppIds({ APPLE_TEAM_ID: "abc", APPLE_BUNDLE_IDS: "com.example.todo" })).toBeNull();
    expect(appleAppIds({ APPLE_TEAM_ID: "ABCDE12345", APPLE_BUNDLE_IDS: "com.example/../x" })).toBeNull();
    warn.mockRestore();
  });
});
