import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ownerIndex } from "../src/core/owner-index";
import { appEnv } from "../src/hosts/cloudflare/env";

describe("ownerIndex", () => {
  it("returns whatever the host hook returns", () => {
    const fake = { marker: true } as never;
    expect(ownerIndex({ ...(env as object), ownerIndex: () => fake } as never)).toBe(fake);
  });

  it("the Cloudflare host wires the singleton DO stub", async () => {
    const stub = ownerIndex(appEnv(env as unknown as Env));
    expect((await stub.authState()).epoch).toMatch(/^[0-9a-f]{32}$/);
  });
});
