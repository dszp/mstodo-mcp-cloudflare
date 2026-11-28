import { useEffect, useRef, useState } from "react";

/**
 * Text that edits in place: a button showing `value`; pressed, it becomes a
 * text box. Enter or leaving the box saves; Escape puts the text back. Saving
 * calls `onCommit` once, with the text on one line and trimmed, and only when
 * it changed and isn't blank: each edit re-filters the whole mirror (the
 * overlay), so nothing is sent per keystroke.
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
  // Enter and Escape end the edit, then the box unmounts and may blur:
  // `finished` keeps that blur from saving a second time.
  const finished = useRef(false);
  const refocus = useRef(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [editing]);

  const finish = (save: boolean, text: string, fromKey: boolean) => {
    if (finished.current) return;
    finished.current = true;
    refocus.current = fromKey;
    setEditing(false);
    const t = text.replace(/\s*\n\s*/g, " ").trim();
    if (save && t !== "" && t !== value) onCommit(t);
  };

  if (!editing) {
    return (
      <button
        ref={button}
        type="button"
        className={`editable${className ? ` ${className}` : ""}`}
        aria-label={`${label}: ${value}`}
        onClick={() => {
          finished.current = false;
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
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finish(true, e.currentTarget.value, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false, "", true);
        }
      }}
      onBlur={(e) => finish(true, e.currentTarget.value, false)}
    />
  );
}
