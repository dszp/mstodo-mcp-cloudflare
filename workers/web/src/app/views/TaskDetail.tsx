import type { MirrorStore } from "../../sync/store.ts";
import {
  accentOf,
  attachmentHref,
  createdLabel,
  dateLabel,
  describeRecurrence,
  instantLabel,
  noteText,
  orderedSteps,
  safeHref,
  sizeLabel,
  splitListName,
} from "../model.ts";
import { useStoreKey } from "../use-store.ts";
import {
  BackIcon,
  BellIcon,
  CalendarIcon,
  CircleIcon,
  FileIcon,
  HomeIcon,
  LinkIcon,
  ListIcon,
  RepeatIcon,
  StarIcon,
  SunIcon,
} from "./icons.tsx";
import { LinkedText } from "./LinkedText.tsx";

/**
 * One task, read-only: title and steps, My Day, reminder, due date, repeat,
 * links and files, the note, and the list and creation date. The note and
 * every title are untrusted and render as text; only http:, https: and
 * mailto: URLs become links.
 */
export function TaskDetail({
  store,
  id,
  today,
  timeZone,
  onBack,
}: {
  store: MirrorStore;
  id: string;
  today: string;
  timeZone: string;
  onBack: () => void;
}) {
  useStoreKey(store, { task: id });
  useStoreKey(store, "lists");
  const t = store.task(id);

  const header = (
    <header className="pane-header detail-header">
      <button type="button" className="back" onClick={onBack}>
        <BackIcon /> Back
      </button>
    </header>
  );
  if (!t) {
    return (
      <aside className="detail-pane" aria-label="Task">
        {header}
        <p className="empty">This task isn't in your synced tasks.</p>
      </aside>
    );
  }

  const done = t.status === "completed";
  const important = t.importance === "high";
  const steps = orderedSteps(t.steps);
  const inMyDay = t.my_day.committed_day === today;
  const due = t.due === null ? null : dateLabel(t.due, today);
  const reminder = t.reminder.on && t.reminder.at !== null ? instantLabel(t.reminder.at, timeZone) : null;
  const repeat = describeRecurrence(t.recurrence);
  const note = noteText(t.body);
  const list = t.list_id === null ? undefined : store.list(t.list_id);
  const listName = list ? splitListName(list.name ?? "Untitled list") : null;
  const listAccent = accentOf(list?.theme.color);
  const created = createdLabel(t.created_at, today, timeZone);

  return (
    <aside className="detail-pane" aria-label="Task">
      {header}
      <div className="detail-scroll">
        <section className="card">
          <div className="detail-title-row">
            <span className="task-circle" role="img" aria-label={done ? "Completed" : "Not completed"}>
              <CircleIcon done={done} />
            </span>
            <h2 className={`detail-title${done ? " done" : ""}`}>{t.title}</h2>
            <span className={`task-star${important ? " on" : ""}`} role="img" aria-label={important ? "Important" : "Not important"}>
              <StarIcon filled={important} />
            </span>
          </div>
          {steps.length > 0 && (
            <ul className="steps">
              {steps.map((s) => (
                <li key={s.id} className={s.checked ? "done" : undefined}>
                  <span className="task-circle" role="img" aria-label={s.checked ? "Completed" : "Not completed"}>
                    <CircleIcon done={s.checked} />
                  </span>
                  <span className="step-title">{s.title ?? ""}</span>
                </li>
              ))}
            </ul>
          )}
          {!t.subresources_complete && <p className="muted small">Steps, links and files haven't synced yet.</p>}
        </section>

        <section className="card">
          <p className={`detail-line${inMyDay ? " set" : ""}`}>
            <SunIcon /> {inMyDay ? "Added to My Day" : "Not in My Day"}
          </p>
        </section>

        <section className="card">
          <p className={`detail-line${reminder ? " set" : ""}`}>
            <BellIcon /> {reminder ? `Remind me ${reminder}` : "No reminder"}
          </p>
          <p className={`detail-line${due ? ` set due-${done ? "future" : due.tone}` : ""}`}>
            <CalendarIcon /> {due ? `Due ${due.text}` : "No due date"}
          </p>
          <p className={`detail-line${repeat ? " set" : ""}`}>
            <RepeatIcon /> {repeat ?? "Doesn't repeat"}
          </p>
        </section>

        {(t.links.length > 0 || t.attachments.length > 0) && (
          <section className="card">
            {t.links.map((l) => {
              const href = safeHref(l.url);
              const text = l.title ?? l.app ?? l.url ?? "Link";
              return (
                <p key={l.id} className="detail-line">
                  <LinkIcon />{" "}
                  {href !== null ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {text}
                    </a>
                  ) : (
                    <span>{text}</span>
                  )}
                </p>
              );
            })}
            {t.attachments.map((a) => {
              const name = a.name ?? "File";
              const size = sizeLabel(a.size);
              return (
                <p key={a.id} className="detail-line file">
                  <FileIcon />{" "}
                  <a href={attachmentHref(a.id)} download={name}>
                    {name}
                  </a>
                  {size !== null && <span className="file-size">{size}</span>}
                </p>
              );
            })}
          </section>
        )}

        {note !== "" && (
          <section className="card note">
            <LinkedText text={note} />
          </section>
        )}
      </div>
      <footer className="detail-footer">
        {listName && (
          <span className={`detail-list${listAccent ? ` accent-${listAccent}` : ""}`}>
            <span className="list-icon">{listName.emoji ?? (list?.wellknown === "defaultList" ? <HomeIcon /> : <ListIcon />)}</span>{" "}
            {listName.title}
          </span>
        )}
        {created && <span className="muted small">{created}</span>}
      </footer>
    </aside>
  );
}
