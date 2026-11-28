// Where to put the caret when text shown as a button or a card turns into a
// text box. A click puts it where the person clicked; opening from the
// keyboard puts it at the end. Typing then inserts there instead of
// replacing the whole text, as selecting it all on open did.

/** A caret index inside a value of `length` characters: `at` clamped, or the end when `at` is null. */
export function caretIndex(at: number | null, length: number): number {
  if (at === null || !Number.isFinite(at)) return length;
  return Math.max(0, Math.min(Math.trunc(at), length));
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/**
 * The character offset, within `root`'s text, of the point a mouse or touch
 * click hit; null for a keyboard activation (`detail` 0), a point outside
 * `root`, or a browser without either caret API. A `<br>` counts as one
 * character, as the newline it stands for does in the text box.
 */
export function caretFromClick(e: { clientX: number; clientY: number; detail: number }, root: Element): number | null {
  if (e.detail === 0) return null;
  const doc = root.ownerDocument as CaretDocument;
  let node: Node | null = null;
  let offset = 0;
  if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
    if (pos !== null) ({ offsetNode: node, offset } = pos);
  } else if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(e.clientX, e.clientY);
    if (range !== null) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (node === null || !root.contains(node) || node.nodeType !== Node.TEXT_NODE) return null;

  let before = 0;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (n === node) return before + offset;
    if (n.nodeType === Node.TEXT_NODE) before += (n as Text).data.length;
    else if ((n as Element).tagName === "BR") before += 1;
  }
  return null;
}

/** Focus `box` and put the caret at `at` (or the end), with nothing selected. */
export function focusAt(box: HTMLTextAreaElement, at: number | null): void {
  box.focus();
  const i = caretIndex(at, box.value.length);
  box.setSelectionRange(i, i);
}
