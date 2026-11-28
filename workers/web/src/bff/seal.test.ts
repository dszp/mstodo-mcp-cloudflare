import { describe, expect, it } from "vitest";
import { sealer } from "./seal.ts";

const SECRET = "0123456789abcdef0123456789abcdef-test-secret";
const OTHER = "fedcba9876543210fedcba9876543210-other-secret";

describe("sealer", () => {
  it("round-trips a value", async () => {
    const s = await sealer(SECRET);
    const sealed = await s.seal("__Host-a", { x: 1, y: ["z"] });
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await s.unseal("__Host-a", sealed)).toEqual({ x: 1, y: ["z"] });
  });

  it("uses a fresh IV per seal", async () => {
    const s = await sealer(SECRET);
    expect(await s.seal("a", 1)).not.toBe(await s.seal("a", 1));
  });

  it("returns null under a different secret", async () => {
    const sealed = await (await sealer(SECRET)).seal("a", { v: 1 });
    expect(await (await sealer(OTHER)).unseal("a", sealed)).toBeNull();
  });

  it("returns null under a different cookie name", async () => {
    const s = await sealer(SECRET);
    const sealed = await s.seal("a", { v: 1 });
    expect(await s.unseal("b", sealed)).toBeNull();
  });

  it("returns null when any byte is flipped", async () => {
    const s = await sealer(SECRET);
    const sealed = await s.seal("a", { v: 1 });
    for (const i of [0, 5, 16, sealed.length - 2]) {
      const c = sealed[i] === "A" ? "B" : "A";
      expect(await s.unseal("a", sealed.slice(0, i) + c + sealed.slice(i + 1)), `index ${i}`).toBeNull();
    }
  });

  it("returns null for garbage", async () => {
    const s = await sealer(SECRET);
    for (const g of ["", "x", "!!!", "not base64 at all", "A".repeat(10), "A".repeat(100)]) {
      expect(await s.unseal("a", g), g).toBeNull();
    }
  });

  it("throws for a secret under 32 bytes, measured as UTF-8", async () => {
    await expect(sealer("short")).rejects.toThrow(/32/);
    await expect(sealer("x".repeat(31))).rejects.toThrow(/32/);
    await expect(sealer("x".repeat(32))).resolves.toBeDefined();
    // 16 two-byte characters = 32 bytes, 16 characters
    await expect(sealer("é".repeat(16))).resolves.toBeDefined();
  });
});
