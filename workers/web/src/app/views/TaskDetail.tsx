import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { MirrorStore, MirrorTask } from "../../sync/store.ts";
import { caretFromClick, focusAt } from "../caret.ts";
import { DateEntry } from "../edit-session.ts";
import type { Edits } from "../edits.ts";
import {
  accentOf,
  attachmentHref,
  createdLabel,
  dateLabel,
  describeRecurrence,
  instantLabel,
  moveTargets,
  neighborAfterRemoval,
  noteEdit,
  noteText,
  orderedSteps,
  reminderFromInput,
  reminderInputValue,
  safeHref,
  sidebarTree,
  sizeLabel,
  splitListName,
} from "../model.ts";
import { useStoreKey } from "../use-store.ts";
import { AddTask } from "./AddTask.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { EditableText, useEditSession } from "./EditableText.tsx";
import {
  BackIcon,
  BellIcon,
  CalendarIcon,
  FileIcon,
  HomeIcon,
  LinkIcon,
  ListIcon,
  PencilIcon,
  RepeatIcon,
  SunIcon,
  TrashIcon,
  XIcon,
} from "./icons.tsx";
import { LinkedText } from "./LinkedText.tsx";
import { CompleteButton, StarButton } from "./TaskRow.tsx";

/**
 * One task: title and steps, My Day, reminder, due date, repeat, links and
 * files, the note, and the list and creation date. With `edits` the title,
 * steps, My Day, reminder, due date, a text note and the list can be changed
 * and the task deleted; repeat, links and files stay read-only (milestone
 * 3b), as does an HTML note (a flagged email's formatting would be lost if it
 * were sent back as text). Without `edits` (a task that isn't in the store)
 * everything is read-only. The note and every title are untrusted and render
 * as text; only http:, https: and mailto: URLs become links. `task` shows a
 * task that isn't in the store (an old search hit, loaded from the server);
 * `placeholder` stands in for it while it loads or when it didn't. A click on
 * a file calls `onOpenAttachment` instead of navigating, so the session can
 * be checked before the download starts; the link still works without
 * script. `onDeleted` runs after the task is deleted here, to close the pane.
 */
export function TaskDetail({
  store,
  id,
  today,
  timeZone,
  onBack,
  onOpenAttachment,
  edits,
  onDeleted,
  myDay,
  task,
  placeholder,
}: {
  store: MirrorStore;
  id: string;
  today: string;
  timeZone: string;
  onBack: () => void;
  onOpenAttachment: (href: string, name: string) => void;
  edits?: Edits;
  onDeleted?: () => void;
  /** Whether the server has My Day on (capabilities.my_day); off hides the My Day row. */
  myDay: boolean;
  task?: MirrorTask;
  placeholder?: ReactNode;
}) {
  useStoreKey(store, { task: id });
  const listsV = useStoreKey(store, "lists");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // After a step is deleted, focus goes to the next step (else the previous),
  // or the add-step box: the deleted step's button is gone, and focus would
  // otherwise fall to the page.
  const stepFocus = useRef<string | null>(null);
  const stepList = useRef<HTMLUListElement>(null);
  const addStepBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const target = stepFocus.current;
    if (target === null) return;
    stepFocus.current = null;
    const row = target === "" ? null : stepList.current?.querySelector<HTMLElement>(`[data-step="${CSS.escape(target)}"] .editable`);
    (row ?? addStepBox.current)?.focus();
  });
  const t = task ?? (placeholder === undefined ? store.task(id) : undefined);
  // Lists only: the tree's task counts aren't shown here.
  const targets = useMemo(() => (edits && t ? moveTargets(sidebarTree(store), t.list_id) : []), [store, listsV, edits, t?.list_id]);

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
        {placeholder ?? <p className="empty">This task isn't in your synced tasks.</p>}
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
  const noteEditable = edits !== undefined && (t.body === null || t.body.type === "text");
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
            <CompleteButton done={done} onToggle={edits && (() => edits.setCompleted(t.id, !done))} />
            <h2 className={`detail-title${done ? " done" : ""}`}>
              {edits ? (
                <EditableText key={t.id} value={t.title} label="Rename task" onCommit={(title) => edits.rename(t.id, title)} />
              ) : (
                t.title
              )}
            </h2>
            <StarButton on={important} onToggle={edits && (() => edits.setImportant(t.id, !important))} />
          </div>
          {steps.length > 0 && (
            <ul className="steps" ref={stepList}>
              {steps.map((s) => (
                <li key={s.id} data-step={s.id} className={s.checked ? "done" : undefined}>
                  <CompleteButton done={s.checked} onToggle={edits && (() => edits.setStepChecked(s.id, !s.checked))} />
                  {edits ? (
                    <>
                      <EditableText
                        className="step-title"
                        value={s.title ?? ""}
                        label="Rename step"
                        onCommit={(title) => edits.renameStep(s.id, title)}
                      />
                      <button
                        type="button"
                        className="icon-button step-delete"
                        aria-label={`Delete step: ${s.title ?? ""}`}
                        onClick={() => {
                          stepFocus.current = neighborAfterRemoval(steps.map((x) => x.id), s.id) ?? "";
                          edits.removeStep(s.id);
                        }}
                      >
                        <XIcon />
                      </button>
                    </>
                  ) : (
                    <span className="step-title">{s.title ?? ""}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {edits && (
            <div className="step-add">
              <AddTask
                inputRef={addStepBox}
                placeholder={steps.length > 0 ? "Next step" : "Add step"}
                onAdd={(title) => {
                  edits.addStep(t.id, title);
                  return true;
                }}
              />
            </div>
          )}
          {!t.subresources_complete && <p className="muted small">Steps, links and files haven't synced yet.</p>}
        </section>

        {myDay && <section className="card">
          {edits ? (
            <button
              type="button"
              className={`detail-line detail-button${inMyDay ? " set" : ""}`}
              aria-pressed={inMyDay}
              onClick={() => edits.setMyDay(t.id, !inMyDay)}
            >
              <SunIcon /> {inMyDay ? "Added to My Day" : "Add to My Day"}
            </button>
          ) : (
            <p className={`detail-line${inMyDay ? " set" : ""}`}>
              <SunIcon /> {inMyDay ? "Added to My Day" : "Not in My Day"}
            </p>
          )}
        </section>}

        <section className="card">
          {edits ? (
            <ReminderRow
              key={`r-${t.id}`}
              at={t.reminder.on ? t.reminder.at : null}
              label={t.reminder.on ? reminder : null}
              onChange={(v) => edits.setReminder(t.id, v)}
            />
          ) : (
            <p className={`detail-line${reminder ? " set" : ""}`}>
              <BellIcon /> {reminder ? `Remind me ${reminder}` : "No reminder"}
            </p>
          )}
          {edits ? (
            <DueRow
              key={`d-${t.id}`}
              due={t.due}
              label={due ? `Due ${due.text}` : null}
              tone={due ? (done ? "future" : due.tone) : null}
              onChange={(v) => edits.setDue(t.id, v)}
            />
          ) : (
            <p className={`detail-line${due ? ` set due-${done ? "future" : due.tone}` : ""}`}>
              <CalendarIcon /> {due ? `Due ${due.text}` : "No due date"}
            </p>
          )}
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
              const href = attachmentHref(a.id);
              return (
                <p key={a.id} className="detail-line file">
                  <FileIcon />{" "}
                  <a
                    href={href}
                    download={name}
                    onClick={(e) => {
                      e.preventDefault();
                      onOpenAttachment(href, name);
                    }}
                  >
                    {name}
                  </a>
                  {size !== null && <span className="file-size">{size}</span>}
                </p>
              );
            })}
          </section>
        )}

        {noteEditable ? (
          <NoteEditor key={t.id} text={note} onSave={(text) => edits!.setNotes(t.id, text)} />
        ) : (
          (note !== "" || edits) && (
            <section className="card note">
              <LinkedText text={note} />
              {edits && <p className="muted small note-readonly">Edit this note in the Potem app.</p>}
            </section>
          )
        )}
      </div>
      <footer className="detail-footer">
        {edits && targets.length > 0 ? (
          <label className={`detail-list move${listAccent ? ` accent-${listAccent}` : ""}`}>
            <span className="list-icon">{listName?.emoji ?? (list?.wellknown === "defaultList" ? <HomeIcon /> : <ListIcon />)}</span>
            <select
              aria-label="Move to list"
              value=""
              onChange={(e) => {
                if (e.target.value !== "") edits.move(t.id, e.target.value);
              }}
            >
              <option value="" disabled>
                {listName?.title ?? "No list"}
              </option>
              {targets.map((m) =>
                m.kind === "list" ? (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ) : (
                  <optgroup key={m.id} label={m.label}>
                    {m.lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
            </select>
          </label>
        ) : (
          listName && (
            <span className={`detail-list${listAccent ? ` accent-${listAccent}` : ""}`}>
              <span className="list-icon">{listName.emoji ?? (list?.wellknown === "defaultList" ? <HomeIcon /> : <ListIcon />)}</span>{" "}
              {listName.title}
            </span>
          )
        )}
        {created && <span className="muted small">{created}</span>}
        {edits && (
          <button type="button" className="icon-button detail-delete" aria-label="Delete task" onClick={() => setConfirmDelete(true)}>
            <TrashIcon />
          </button>
        )}
      </footer>
      {edits && confirmDelete && (
        <ConfirmDialog
          message={`Delete "${t.title}"?`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            edits.remove(t.id);
            onDeleted?.();
          }}
        />
      )}
    </aside>
  );
}

// The browser's zone: a datetime-local input shows and takes wall time there.
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * A date or datetime-local input. A whole, changed value saves 600 ms after
 * it is picked or typed, and at once when the input is left, on Enter, or
 * when it unmounts (DateEntry); an emptied field (the native clear) clears on
 * leave or Enter, while a partly cleared one (validity.badInput) is put back
 * to the saved value. `read` turns the input's value into the saved form.
 */
function DateInput({
  type,
  label,
  current,
  shown,
  read,
  onChange,
  onDone,
  picker,
}: {
  type: "date" | "datetime-local";
  label: string;
  current: string | null;
  shown: string;
  read: (v: string) => string | null;
  onChange: (value: string | null) => void;
  /** Called when editing ends: the input was left, Enter, or Escape. */
  onDone: () => void;
  /** Open the browser's picker too: the row was pressed with a pointer, not the keyboard. */
  picker: boolean;
}) {
  const [draft, setDraft] = useState(shown);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The row was just pressed: focus the input, and for a pointer press open
    // the browser's picker too (showPicker needs the press's user activation,
    // still live here). A keyboard press only focuses, because an open picker
    // takes the keys and the date couldn't be typed.
    const el = input.current;
    if (!el) return;
    el.focus();
    if (!picker) return;
    try {
      el.showPicker?.();
    } catch {
      // No picker, or no activation left: the focused input is enough.
    }
  }, []);
  const [prev, setPrev] = useState(shown);
  if (prev !== shown) {
    // The task changed (here or elsewhere): show its value.
    setPrev(shown);
    setDraft(shown);
  }
  const entry = useRef<DateEntry | null>(null);
  entry.current ??= new DateEntry(platformSchedule);
  entry.current.sync(current, read, onChange);
  useEffect(() => {
    const e = entry.current!;
    return () => e.close();
  }, []);
  const commit = () => {
    if (!entry.current!.commit()) setDraft(shown);
  };
  const finish = () => {
    commit();
    onDone();
  };
  return (
    <input
      ref={input}
      type={type}
      className="date-input"
      aria-label={label}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        entry.current!.change(e.target.value, e.target.validity.badInput);
      }}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish();
        } else if (e.key === "Escape") {
          e.preventDefault();
          entry.current!.discard();
          onDone();
        }
      }}
    />
  );
}

const platformSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/**
 * The reminder row: "Remind me" or "Remind me <time>" until pressed; then a
 * datetime-local input in the browser's zone, with its picker open. Clear
 * removes a set reminder.
 */
function ReminderRow({
  at,
  label,
  onChange,
}: {
  at: string | null;
  /** The reminder's time as shown (the owner's zone), or null when none is set. */
  label: string | null;
  onChange: (instant: string | null) => void;
}) {
  const [open, setOpen] = useState<null | { picker: boolean }>(null);
  const zone = browserZone();
  // Compared as the input reads it, so a stored instant with seconds or
  // milliseconds doesn't count as a change.
  const current = at === null ? null : reminderFromInput(reminderInputValue(at, zone), zone);
  return (
    <div className={`detail-line${at !== null ? " set" : ""}`}>
      <BellIcon />
      {open ? (
        <DateInput
          type="datetime-local"
          label="Reminder"
          current={current}
          shown={at === null ? "" : reminderInputValue(at, zone)}
          read={(v) => reminderFromInput(v, zone)}
          onChange={onChange}
          onDone={() => setOpen(null)}
          picker={open.picker}
        />
      ) : (
        <button type="button" className="line-button" onClick={(e) => setOpen({ picker: e.detail > 0 })}>
          {label !== null ? `Remind me ${label}` : "Remind me"}
        </button>
      )}
      {at !== null && !open && (
        <button type="button" className="icon-button" aria-label="Clear reminder" onClick={() => onChange(null)}>
          <XIcon />
        </button>
      )}
    </div>
  );
}

/**
 * The due-date row: "Add due date" or "Due <day>" until pressed; then a date
 * input (the bare date the feed uses) with its picker open. Clear removes a
 * set date.
 */
function DueRow({
  due,
  label,
  tone,
  onChange,
}: {
  due: string | null;
  label: string | null;
  tone: string | null;
  onChange: (date: string | null) => void;
}) {
  const [open, setOpen] = useState<null | { picker: boolean }>(null);
  return (
    <div className={`detail-line${label ? ` set due-${tone}` : ""}`}>
      <CalendarIcon />
      {open ? (
        <DateInput
          type="date"
          label="Due date"
          current={due}
          shown={due ?? ""}
          read={(v) => v}
          onChange={onChange}
          onDone={() => setOpen(null)}
          picker={open.picker}
        />
      ) : (
        <button type="button" className="line-button" onClick={(e) => setOpen({ picker: e.detail > 0 })}>
          {label ?? "Add due date"}
        </button>
      )}
      {due !== null && !open && (
        <button type="button" className="icon-button" aria-label="Clear due date" onClick={() => onChange(null)}>
          <XIcon />
        </button>
      )}
    </div>
  );
}

/**
 * A plain-text note. It shows as text (with its links) until pressed; then a
 * text box. Leaving the box or Ctrl/Cmd-Enter saves it; Escape puts back the
 * note as it was. Nothing is sent while typing. The save compares with the
 * note the box opened with, and unmounting with the box open saves too
 * (EditSession).
 */
function NoteEditor({ text, onSave }: { text: string; onSave: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const session = useEditSession(noteEdit, onSave);
  // Ctrl/Cmd-Enter and Escape end the edit, then the box unmounts and may
  // blur: the session saves only on the first finish.
  const finish = (save: boolean, value?: string) => {
    if (!session.isOpen) return;
    setEditing(false);
    session.finish(save, value);
  };
  const box = useRef<HTMLTextAreaElement>(null);
  // Where the click landed in the note, so the caret goes there (null: the end).
  const caret = useRef<number | null>(null);
  useEffect(() => {
    if (editing && box.current) focusAt(box.current, caret.current);
  }, [editing]);
  const start = (at: number | null) => {
    caret.current = at;
    session.open(text);
    setEditing(true);
  };

  if (editing) {
    return (
      <section className="card note editing">
        <textarea
          className="note-input"
          aria-label="Note"
          defaultValue={text}
          ref={box}
          rows={6}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              finish(true, e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              finish(false);
            }
          }}
          onChange={(e) => session.type(e.currentTarget.value)}
          onBlur={(e) => finish(true, e.currentTarget.value)}
        />
      </section>
    );
  }
  return (
    <section
      className="card note"
      onClick={(e) => {
        // A click on a link in the note follows it; anywhere else edits.
        if (!(e.target instanceof Element && e.target.closest("a"))) start(caretFromClick(e.nativeEvent, e.currentTarget));
      }}
    >
      {text !== "" ? <LinkedText text={text} /> : <span className="muted">Add a note</span>}
      <button type="button" className="icon-button note-edit" aria-label={text !== "" ? "Edit note" : "Add a note"} onClick={(e) => {
        e.stopPropagation();
        start(null);
      }}>
        <PencilIcon />
      </button>
    </section>
  );
}
