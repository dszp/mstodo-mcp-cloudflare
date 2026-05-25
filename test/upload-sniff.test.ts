import { describe, expect, it } from "vitest";
import { resolveContentType, sniffMime } from "../src/upload/sniff";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0]);
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
const webp = (() => {
  const b = new Uint8Array(12);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return b;
})();
const text = new Uint8Array([0x68, 0x69, 0x0a]); // "hi\n"

describe("sniffMime", () => {
  it("recognizes known magic bytes", () => {
    expect(sniffMime(png)).toBe("image/png");
    expect(sniffMime(jpg)).toBe("image/jpeg");
    expect(sniffMime(gif)).toBe("image/gif");
    expect(sniffMime(pdf)).toBe("application/pdf");
    expect(sniffMime(zip)).toBe("application/zip");
    expect(sniffMime(webp)).toBe("image/webp");
  });

  it("returns null for unrecognized bytes", () => {
    expect(sniffMime(text)).toBeNull();
  });
});

describe("resolveContentType precedence", () => {
  it("prefers the sniffed type over a (wrong) claimed type", () => {
    expect(resolveContentType("photo.txt", png, "text/plain")).toBe("image/png");
  });

  it("uses the claimed type when bytes are unrecognized", () => {
    expect(resolveContentType("note.bin", text, "text/plain")).toBe("text/plain");
  });

  it("falls back to the extension when the claim is octet-stream", () => {
    expect(resolveContentType("data.csv", text, "application/octet-stream")).toBe("text/csv");
  });

  it("falls back to octet-stream as a last resort", () => {
    expect(resolveContentType("mystery.qqq", text, undefined)).toBe("application/octet-stream");
  });
});
