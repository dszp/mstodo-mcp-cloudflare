import { useEffect, useRef, useState } from "react";
import { EditSession } from "../edit-session.ts";
import { titleEdit } from "../model.ts";

/**
 * An EditSession for one box, kept across renders: it saves what was typed
 * when the component unmounts with the box open (EditSession explains why it
 * compares with the text the box opened with).
 */
export function useEditSession(decide: (original: string, typed: string) => string | null, onCommit: (text: string) => void): EditSession {
  const session = useRef<EditSession | null>(null);
  session.current ??= new EditSession(decide);
  session.current.onCommit = onCommit;
  useEffect(() => {
    const s = session.current!;
    return () => s.close();
  }, []);
  return session.current;
}

/**
 * Text that edits in place: a button showing `value`; pressed, it becomes a
 * text box. Enter or leaving the box saves; Escape puts the text back.
 * Saving calls `onCommit` once, with the text on one line and trimmed, and
 * only when it isn't blank and differs from the text the box opened with
 * (titleEdit), so opening and leaving the box sends nothing, even if the
 * title changed elsewhere meanwhile. Unmounting with the box open saves too.
 * Each edit re-filters the whole mirror (the overlay), so nothing is sent per
 * keystroke.
 */
export function EditableText({
  value,
  label,
  onCommit,
  className,
}: {
  value: string;
  /** What the control does, e.g. "Rename task"; the button's name is "<label>: <value>". */
  label: string;
  onCommit: (text: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const session = useEditSession(titleEdit, onCommit);
  const refocus = useRef(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [editing]);

  // Enter and Escape end the edit, then the box unmounts and may blur: the
  // session saves only on the first finish.
  const finish = (save: boolean, text: string | undefined, fromKey: boolean) => {
    if (!session.isOpen) return;
    refocus.current = fromKey;
    setEditing(false);
    session.finish(save, text);
  };

  if (!editing) {
    return (
      <button
        ref={button}
        type="button"
        className={`editable${className ? ` ${className}` : ""}`}
        aria-label={`${label}: ${value}`}
        onClick={() => {
          session.open(value);
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  }
  return (
    <textarea
      className={`editable-input${className ? ` ${className}` : ""}`}
      aria-label={label}
      defaultValue={value}
      rows={1}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => session.type(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finish(true, e.currentTarget.value, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false, undefined, true);
        }
      }}
      onBlur={(e) => finish(true, e.currentTarget.value, false)}
    />
  );
}
