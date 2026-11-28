import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * A modal question with Cancel and a confirm button, on the page's own
 * <dialog> rather than window.confirm: the browser keeps focus inside it,
 * Escape cancels, and closing it returns focus to where it was. Render it to
 * ask; unmount it to dismiss. Cancel has focus first, so a stray Enter or
 * Space doesn't delete. It renders into <body>: on a narrow screen the pane
 * that asks can be hidden (display: none), which would hide the dialog too.
 */
export function ConfirmDialog({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    return () => {
      if (d.open) d.close();
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="confirm"
      aria-label={message}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <p>{message}</p>
      <div className="confirm-buttons">
        <button type="button" autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
