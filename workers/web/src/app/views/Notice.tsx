import { useEffect, useState, useSyncExternalStore } from "react";
import type { Notice, Notices } from "../editing.ts";
import { editStatusText, noticeText } from "../model.ts";
import type { Outbox } from "../../sync/outbox.ts";
import { visibleTimeout } from "../visible-timer.ts";
import { XIcon } from "./icons.tsx";

/** How long a notice stays, counted while the page is visible, before it goes away on its own. */
const NOTICE_MS = 6_000;

const subscribeOnline = (fn: () => void) => {
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
  return () => {
    window.removeEventListener("online", fn);
    window.removeEventListener("offline", fn);
  };
};

/**
 * The corner of the page that reports on edits: "Saving…" while the outbox
 * holds unsent ones (or that they wait for the connection while offline),
 * and a notice for each edit the server refused or partly skipped. Screen
 * readers hear the notices (role="status"), not "Saving…".
 */
export function EditStatus({ outbox, notices }: { outbox: Pick<Outbox, "unsent" | "subscribe">; notices: Notices }) {
  const unsent = useSyncExternalStore(outbox.subscribe, () => outbox.unsent().length > 0);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine);
  const items = useSyncExternalStore(notices.subscribe, notices.list);
  const status = editStatusText(unsent, online);
  return (
    <div className="edit-status">
      <div className="notices" role="status" aria-live="polite">
        {items.map((n) => (
          <NoticeItem key={n.id} notice={n} onDismiss={() => notices.dismiss(n.id)} />
        ))}
      </div>
      {/* Outside the live region: a screen reader shouldn't announce every save. */}
      {status && <p className="saving">{status}</p>}
    </div>
  );
}

/**
 * Writes `text` to the clipboard: true when it worked. False, never a throw,
 * when the page has no clipboard (an insecure origin, an old browser) or the
 * browser refuses the write.
 */
export async function copyText(text: string, clipboard: Pick<Clipboard, "writeText"> | undefined): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * One notice. It goes away after NOTICE_MS of the page being visible, except
 * one holding a refused note's text: that stays until dismissed, so the text
 * can still be copied.
 */
export function NoticeItem({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const recover = notice.recoverText;
  useEffect(() => {
    if (recover !== undefined) return;
    return visibleTimeout(document, NOTICE_MS, onDismiss);
    // The notice's id fixes it; a fresh onDismiss each render mustn't restart the timer.
  }, [notice.id]);
  return (
    <p className="notice">
      <span>{noticeText(notice.op, notice.error, notice.fields)}</span>
      {recover !== undefined && (
        <button
          type="button"
          className="notice-action"
          onClick={() => void copyText(recover, navigator.clipboard).then(setCopied)}
        >
          {copied === true ? "Copied" : copied === false ? "Couldn't copy" : "Copy my text"}
        </button>
      )}
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon />
      </button>
    </p>
  );
}
