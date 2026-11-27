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
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Outside Unicode, String.fromCodePoint throws: leave the entity as written.
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

// Elements whose contents are not text a reader sees.
const RAW_TEXT = ["script", "style"];
const endsName = (c: string | undefined): boolean => c === undefined || c === ">" || c === "/" || /\s/.test(c);

// The raw-text element a tag at `lt` opens, if any.
function rawTextElement(input: string, lt: number): string | null {
  for (const name of RAW_TEXT) {
    if (input.slice(lt + 1, lt + 1 + name.length).toLowerCase() === name && endsName(input[lt + 1 + name.length])) {
      return name;
    }
  }
  return null;
}

// Index just past the `</name …>` that closes a raw-text element whose content
// starts at `from`, or the input's length when it is never closed.
function skipRawText(input: string, name: string, from: number): number {
  let i = from;
  for (;;) {
    const close = input.indexOf("</", i);
    if (close === -1) return input.length;
    const after = close + 2 + name.length;
    if (input.slice(close + 2, after).toLowerCase() === name && endsName(input[after])) {
      const gt = input.indexOf(">", after);
      return gt === -1 ? input.length : gt + 1;
    }
    i = close + 2;
  }
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
    const raw = rawTextElement(input, lt);
    i = raw === null ? gt + 1 : skipRawText(input, raw, gt + 1);
  }
  const decoded = decodeEntities(withoutTags);
  return decoded.replace(/\s+/g, " ").trim();
}
