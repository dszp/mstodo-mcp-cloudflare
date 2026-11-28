// The text and date boxes' side of an edit, kept out of React so it can be
// tested without a DOM. An edit box must not lose what was typed or picked:
// it saves when it unmounts while open (another task opened, the pane
// closed), it marks itself dirty so closing the tab asks first, and a date
// saves 600 ms after a whole value is picked as well as on blur or Enter.

import { type DateCommit, dateInputCommit } from "./model.ts";

export type Cancel = () => void;

/** Which edit boxes hold something that would be saved. main.tsx's leave-page warning reads it. */
export interface DirtyRegistry {
  set(editor: object, dirty: boolean): void;
  delete(editor: object): void;
  any(): boolean;
}

export function createDirtyRegistry(): DirtyRegistry {
  const dirty = new Set<object>();
  return {
    set: (e, d) => void (d ? dirty.add(e) : dirty.delete(e)),
    delete: (e) => void dirty.delete(e),
    any: () => dirty.size > 0,
  };
}

/** The page's registry. */
export const dirtyEditors = createDirtyRegistry();

/**
 * One text box's edit. `decide(original, typed)` returns the text to save or
 * null (titleEdit, noteEdit). The original is the text the box opened with:
 * comparing with the value at commit time would send back text the user never
 * changed, overwriting an edit another device made while the box was open.
 */
export class EditSession {
  /** Set on every render, so the newest callback saves. */
  onCommit: (text: string) => void = () => {};
  readonly #decide: (original: string, typed: string) => string | null;
  readonly #registry: DirtyRegistry;
  #original = "";
  #typed: string | null = null;
  #open = false;

  constructor(decide: (original: string, typed: string) => string | null, registry: DirtyRegistry = dirtyEditors) {
    this.#decide = decide;
    this.#registry = registry;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  open(value: string): void {
    this.#original = value;
    this.#typed = null;
    this.#open = true;
    this.#registry.set(this, false);
  }

  type(text: string): void {
    if (!this.#open) return;
    this.#typed = text;
    this.#registry.set(this, this.#decide(this.#original, text) !== null);
  }

  /** Ends the edit, saving `text` (else what was typed) when `save`. Only the first call counts. */
  finish(save: boolean, text?: string): void {
    if (!this.#open) return;
    this.#open = false;
    this.#registry.delete(this);
    const typed = text ?? this.#typed;
    const next = save && typed !== null ? this.#decide(this.#original, typed) : null;
    if (next !== null) this.onCommit(next);
  }

  /** The box unmounts: an open edit saves what was typed. */
  close(): void {
    this.finish(true);
  }
}

/** How long a date or datetime input waits after a whole value is picked before saving it. */
export const DATE_DEBOUNCE_MS = 600;

/**
 * One date or datetime-local input. `change` records each value with the
 * input's `validity.badInput`: a native field the user has partly cleared
 * reports "" with badInput true, which is not a clear. A whole, changed value
 * saves after DATE_DEBOUNCE_MS; `commit` (blur, Enter) and `close` (unmount)
 * save at once.
 */
export class DateEntry {
  readonly #schedule: (fn: () => void, ms: number) => Cancel;
  readonly #registry: DirtyRegistry;
  #current: string | null = null;
  #read: (v: string) => string | null = (v) => v;
  #onChange: (value: string | null) => void = () => {};
  #draft: { value: string; badInput: boolean } | null = null;
  #timer: Cancel | null = null;

  constructor(schedule: (fn: () => void, ms: number) => Cancel, registry: DirtyRegistry = dirtyEditors) {
    this.#schedule = schedule;
    this.#registry = registry;
  }

  /** The saved value (as `read` returns it), the reader, and where saves go; set on every render. */
  sync(current: string | null, read: (v: string) => string | null, onChange: (value: string | null) => void): void {
    this.#current = current;
    this.#read = read;
    this.#onChange = onChange;
  }

  #decision(): DateCommit {
    if (this.#draft === null) return { kind: "none" };
    return dateInputCommit(this.#draft.value, this.#current, this.#read, this.#draft.badInput);
  }

  #cancel(): void {
    this.#timer?.();
    this.#timer = null;
  }

  change(value: string, badInput: boolean): void {
    this.#cancel();
    this.#draft = { value, badInput };
    const c = this.#decision();
    if (c.kind === "set") {
      this.#timer = this.#schedule(() => {
        this.#timer = null;
        this.commit();
      }, DATE_DEBOUNCE_MS);
    }
    this.#registry.set(this, c.kind !== "none");
  }

  /** Saves the recorded value now. False when there was nothing to save, so the input shows the saved value again. */
  commit(): boolean {
    this.#cancel();
    const c = this.#decision();
    this.#draft = null;
    this.#registry.delete(this);
    if (c.kind === "set") this.#onChange(c.value);
    else if (c.kind === "clear") this.#onChange(null);
    return c.kind !== "none";
  }

  close(): void {
    this.commit();
  }
}
