// Phase 5 — minimal HTML→plaintext for indexing To Do task bodies.
//
// Microsoft To Do bodies carry a contentType of `text` or `html`. Only `html`
// bodies are stripped; anything else (including an absent contentType) passes
// through verbatim so we never mangle plaintext. Tags become spaces (so words
// don't fuse), entities are decoded, and whitespace is collapsed — enough for
// FTS5 indexing and snippet display, not a full HTML renderer.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

export function stripHtml(input: string, contentType?: string): string {
  if (contentType !== "html") return input;
  const withoutTags = input.replace(/<[^>]*>/g, " ");
  const decoded = decodeEntities(withoutTags);
  return decoded.replace(/\s+/g, " ").trim();
}
