import type { FeedTask } from "./feed";

// A task body's plain text, which local search matches (docs/SYNC-API.md
// section 4.10). A copy of stripHtml in packages/core/util/html.ts, which the
// server's search index uses: the engine may import core only for types, so the
// rule lives twice, and plain-text.test.ts pins both to the same cases.
//
// For an html body: each tag becomes a space, the contents of <script> and
// <style> are dropped, entities are decoded, whitespace runs collapse to one
// space and the ends are trimmed. Any other body is returned as it is.

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const RAW_TEXT = ["script", "style"];
const endsName = (c: string | undefined): boolean => c === undefined || c === ">" || c === "/" || /\s/.test(c);

function rawTextElement(input: string, lt: number): string | null {
  for (const name of RAW_TEXT) {
    if (input.slice(lt + 1, lt + 1 + name.length).toLowerCase() === name && endsName(input[lt + 1 + name.length])) {
      return name;
    }
  }
  return null;
}

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

// Linear: indexOf scans never revisit input. A "<" with no ">" after it is
// left as written.
function htmlToText(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out += input.slice(i);
      break;
    }
    const gt = input.indexOf(">", lt + 1);
    if (gt === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, lt) + " ";
    const raw = rawTextElement(input, lt);
    i = raw === null ? gt + 1 : skipRawText(input, raw, gt + 1);
  }
  return decodeEntities(out).replace(/\s+/g, " ").trim();
}

export function bodyText(body: FeedTask["body"]): string {
  if (body === null) return "";
  return body.type === "html" ? htmlToText(body.content) : body.content;
}
