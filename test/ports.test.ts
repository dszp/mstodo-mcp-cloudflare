import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { KeyValueStore, AppEnv } from "../src/core/ports";

describe("ports", () => {
  it("Cloudflare KV satisfies KeyValueStore structurally", async () => {
    const kv: KeyValueStore = env.TODO_CACHE; // compile-time assertion
    await kv.put("ports:test", "v", { expirationTtl: 60 });
    expect(await kv.get("ports:test", "text")).toBe("v");
    await kv.delete("ports:test");
  });

  it("the worker Env is assignable to AppEnv", () => {
    const e: AppEnv = env as unknown as Env; // compile-time assertion
    expect(e.TIMEZONE).toBeTypeOf("string");
  });
});
