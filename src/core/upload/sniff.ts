// Content-type detection from the leading bytes of an uploaded file. Pure — no
// I/O. Microsoft To Do accepts arbitrary file attachments, so unlike the sibling
// Obsidian project there is no extension allowlist to enforce: sniffing here is
// used only to pick the most accurate content type to hand to Graph (bytes are
// authoritative when recognized; otherwise we trust the browser-supplied type,
// then the filename extension, then fall back to application/octet-stream).

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** Detect a MIME type from leading magic bytes, or null if unrecognized. */
export function sniffMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"; // GIF8(7|9)a
  // WEBP: "RIFF" .... "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  // ZIP container (also docx/xlsx/pptx) — "PK\x03\x04" / empty/spanned variants.
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "application/zip";
  }
  return null;
}

// Minimal extension → MIME fallback, used only when the bytes aren't recognized
// and the browser didn't supply a usable content type.
const EXT_MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot <= 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * Choose the content type to store the attachment with. Precedence:
 *   1. sniffed type from the bytes (authoritative when recognized);
 *   2. the browser-supplied type, if it's meaningful (not octet-stream);
 *   3. an extension-based guess;
 *   4. application/octet-stream.
 */
export function resolveContentType(
  filename: string,
  bytes: Uint8Array,
  claimedType?: string | null,
): string {
  const sniffed = sniffMime(bytes);
  if (sniffed) return sniffed;
  const claimed = (claimedType ?? "").trim().toLowerCase();
  if (claimed && claimed !== "application/octet-stream") return claimed;
  return EXT_MIME[extOf(filename)] ?? "application/octet-stream";
}
