import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { AppEnv } from "../src/core/ports";
import { storeTokens, loadTokens, SCOPES } from "../src/core/auth/microsoft";
import { loadListsConfig } from "../src/core/config/loader";

function memoryKv() {
  const m = new Map<string, string>();
  return {
    async get(k: string, t: "text" | "json") { const v = m.get(k) ?? null; return t === "json" && v ? JSON.parse(v) : v; },
    async put(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map((name) => ({ name })), list_complete: true }; },
  } as AppEnv["TODO_CACHE"];
}

describe("core runs on an AppEnv built from ports", () => {
  it("seals and reads tokens through a non-Cloudflare KV", async () => {
    const appEnv: AppEnv = { ...(env as unknown as AppEnv), TODO_CACHE: memoryKv(), OAUTH_KV: memoryKv() };
    const t = { access_token: "a", refresh_token: "r", expires_at: 1, scope: SCOPES, obtained_at: 1 };
    await storeTokens(appEnv, t);
    expect(await loadTokens(appEnv)).toEqual(t);
    expect(await loadListsConfig(appEnv)).toBeTruthy();
  });
});
