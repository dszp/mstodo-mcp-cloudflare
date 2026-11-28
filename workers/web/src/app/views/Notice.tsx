import { useEffect, useSyncExternalStore } from "react";
import type { Notice, Notices } from "../editing.ts";
import { noticeText } from "../model.ts";
import type { Outbox } from "../../sync/outbox.ts";
import { XIcon } from "./icons.tsx";

/** How long a notice stays before it goes away on its own. */
const NOTICE_MS = 6_000;

/**
 * The corner of the page that reports on edits: "Saving…" while the outbox
 * holds any, and a notice for each edit the server refused. Screen readers
 * hear both (aria-live="polite").
 */
export function EditStatus({ outbox, notices }: { outbox: Pick<Outbox, "pending" | "subscribe">; notices: Notices }) {
  const saving = useSyncExternalStore(outbox.subscribe, () => outbox.pending().length > 0);
  const items = useSyncExternalStore(notices.subscribe, notices.list);
  return (
    <div className="edit-status" aria-live="polite">
      {items.map((n) => (
        <NoticeItem key={n.id} notice={n} onDismiss={() => notices.dismiss(n.id)} />
      ))}
      {saving && <p className="saving">Saving…</p>}
    </div>
  );
}

function NoticeItem({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, NOTICE_MS);
    return () => clearTimeout(t);
    // The notice's id fixes it; a fresh onDismiss each render mustn't restart the timer.
  }, [notice.id]);
  return (
    <p className="notice">
      <span>{noticeText(notice.op, notice.error)}</span>
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon />
      </button>
    </p>
  );
}
