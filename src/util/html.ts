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
  // Linear, backtracking-free tag strip — equivalent to replacing /<[^>]*>/g
  // with a space, but without that pattern's quadratic worst case on input like
  // "<<<<…" with no closing ">". Each complete <…> run becomes one space; a
  // trailing unclosed "<" (no following ">") is left verbatim, exactly as the
  // regex left it. Non-overlapping indexOf scans → O(n).
  let withoutTags = "";
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      withoutTags += input.slice(i);
      break;
    }
    const gt = input.indexOf(">", lt + 1);
    if (gt === -1) {
      withoutTags += input.slice(i);
      break;
    }
    withoutTags += input.slice(i, lt) + " ";
    i = gt + 1;
  }
  const decoded = decodeEntities(withoutTags);
  return decoded.replace(/\s+/g, " ").trim();
}
