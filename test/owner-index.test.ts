import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ownerIndex } from "../src/core/owner-index";

describe("ownerIndex", () => {
  it("uses the host hook when present", () => {
    const fake = { marker: true } as never;
    expect(ownerIndex({ ...(env as object), ownerIndex: () => fake } as never)).toBe(fake);
  });

  it("falls back to the Cloudflare singleton stub", async () => {
    const stub = ownerIndex(env as never);
    expect((await stub.authState()).epoch).toMatch(/^[0-9a-f]{32}$/);
  });
});
