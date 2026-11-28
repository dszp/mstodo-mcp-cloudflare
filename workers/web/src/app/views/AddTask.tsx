import { type Ref, useState } from "react";
import { PlusIcon } from "./icons.tsx";

/**
 * The "Add a task" box at the bottom of a list, and the "Next step" box of a
 * task. Enter adds and empties the box, keeping focus in it for the next one.
 * `onAdd` gets the text as typed; the edit action trims it and ignores a
 * blank one. When `onAdd` returns false the add failed and the text stays.
 */
export function AddTask({
  onAdd,
  inputRef,
  placeholder = "Add a task",
}: {
  onAdd: (title: string) => boolean;
  inputRef?: Ref<HTMLInputElement>;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="add-task"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() === "") return;
        if (onAdd(text)) setText("");
      }}
    >
      <PlusIcon className="add-icon" />
      <input
        ref={inputRef}
        type="text"
        className="add-input"
        aria-label={placeholder}
        placeholder={placeholder}
        value={text}
        enterKeyHint="done"
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setText("");
            e.currentTarget.blur();
          }
        }}
      />
    </form>
  );
}
