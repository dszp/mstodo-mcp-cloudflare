import { type ReactNode, memo } from "react";
import { bodyText } from "../../sync/plain-text.ts";
import type { MirrorStore, MirrorTask } from "../../sync/store.ts";
import type { Edits } from "../edits.ts";
import { dateLabel, instantLabel, splitListName } from "../model.ts";
import type { Route } from "../route.ts";
import { useStoreKey } from "../use-store.ts";
import {
  BellIcon,
  CalendarIcon,
  CheckCircleIcon,
  CircleIcon,
  LinkIcon,
  NoteIcon,
  PaperclipIcon,
  RepeatIcon,
  StarIcon,
  SunIcon,
} from "./icons.tsx";
import { RouteLink } from "./RouteLink.tsx";

/** What a row's circle and star do. The app passes its one Edits, so the prop never changes. */
export type RowEdits = Pick<Edits, "setCompleted" | "setImportant">;

export interface RowOptions {
  /** Show the task's list (smart lists). */
  showList: boolean;
  /** Show "My Day" when the task is in it (everywhere but My Day). */
  showMyDay: boolean;
  /** Show the day it was completed (Completed). */
  showCompletedDay: boolean;
}

/**
 * One mirrored task as a card. Subscribes to its own task, so a change to one
 * task re-renders one row. `view` is the route the row sits in; the row links
 * to it with `?task=<id>`.
 */
export const TaskRow = memo(function TaskRow({
  store,
  id,
  view,
  today,
  timeZone,
  selected,
  options,
  edits,
}: {
  store: MirrorStore;
  id: string;
  view: Route;
  today: string;
  timeZone: string;
  selected: boolean;
  options: RowOptions;
  edits?: RowEdits;
}) {
  useStoreKey(store, { task: id });
  // A row that shows its list's name follows a rename. Subscribing here
  // rather than passing the name down: only the ~30 rendered rows subscribe,
  // and TaskList's own "lists" re-render can't reach rows through memo. A
  // row without the name repeats its task key (a no-op second subscription).
  useStoreKey(store, options.showList ? "lists" : { task: id });
  const t = store.task(id);
  if (!t) return null;
  return (
    <TaskCard store={store} t={t} view={view} today={today} timeZone={timeZone} selected={selected} options={options} edits={edits} />
  );
});

/**
 * A task as a card: completion circle, title, the details line, and the star.
 * With `edits` the circle and star are buttons; without (a hit from "search
 * all history", which isn't in the store) they show state only. The title
 * area is the link that opens the task; it covers the card (CSS), and the
 * buttons sit above it. `t` need not be in the store; only its list's name
 * is read from there.
 */
export function TaskCard({
  store,
  t,
  view,
  today,
  timeZone,
  selected,
  options,
  edits,
}: {
  store: MirrorStore;
  t: MirrorTask;
  view: Route;
  today: string;
  timeZone: string;
  selected: boolean;
  options: RowOptions;
  edits?: RowEdits;
}) {
  const id = t.id;
  const done = t.status === "completed";
  const important = t.importance === "high";

  const parts: ReactNode[] = [];
  if (options.showList && t.list_id !== null) {
    const name = store.list(t.list_id)?.name;
    if (name) {
      const { emoji, title } = splitListName(name);
      parts.push(<span key="list">{emoji !== null ? `${emoji} ${title}` : title}</span>);
    }
  }
  if (options.showCompletedDay && done && t.completed_at !== null) {
    parts.push(
      <span key="done">
        <CheckCircleIcon /> {dateLabel(t.completed_at, today).text}
      </span>,
    );
  }
  if (options.showMyDay && t.my_day.committed_day === today) {
    parts.push(
      <span key="myday">
        <SunIcon /> My Day
      </span>,
    );
  }
  if (t.steps.length > 0) {
    parts.push(<span key="steps">{`${t.steps.filter((s) => s.checked).length} of ${t.steps.length}`}</span>);
  }
  if (t.due !== null) {
    const due = dateLabel(t.due, today);
    parts.push(
      <span key="due" className={done ? undefined : `due-${due.tone}`}>
        <CalendarIcon /> {due.text}
        {t.recurrence !== null && (
          <>
            {" "}
            <RepeatIcon />
          </>
        )}
      </span>,
    );
  }
  if (t.reminder.on && t.reminder.at !== null) {
    const at = instantLabel(t.reminder.at, timeZone);
    if (at !== null) {
      parts.push(
        <span key="reminder">
          <BellIcon /> {at}
        </span>,
      );
    }
  }
  if (bodyText(t.body).trim() !== "") {
    parts.push(
      <span key="note">
        <NoteIcon /> Note
      </span>,
    );
  }
  if (t.links.length > 0) {
    parts.push(
      <span key="link">
        <LinkIcon /> {t.links[0]!.app ?? "Link"}
      </span>,
    );
  }
  if (t.attachments.length > 0) {
    parts.push(
      <span key="files" aria-label="Has files">
        <PaperclipIcon />
      </span>,
    );
  }

  return (
    <div className={`task-card${selected ? " selected" : ""}${done ? " done" : ""}`} data-task={id}>
      <CompleteButton done={done} onToggle={edits && (() => edits.setCompleted(id, !done))} />
      <RouteLink to={{ ...view, task: id }} className="task-link" current={selected}>
        <span className="task-text">
          <span className="task-title">{t.title}</span>
          {parts.length > 0 && <span className="task-meta">{parts}</span>}
        </span>
      </RouteLink>
      <StarButton on={important} onToggle={edits && (() => edits.setImportant(id, !important))} />
    </div>
  );
}

// The circle and the star are buttons beside the row's link, not inside it
// (a link can't hold a button). The click stops here, so it never also opens
// the task.

/** A completion circle: a button with `onToggle`, else a picture of the state. */
export function CompleteButton({ done, onToggle, className = "task-circle" }: { done: boolean; onToggle?: () => void; className?: string }) {
  if (!onToggle) {
    return (
      <span className={className} role="img" aria-label={done ? "Completed" : "Not completed"}>
        <CircleIcon done={done} />
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${className} icon-button`}
      aria-label={done ? "Mark not complete" : "Mark complete"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <CircleIcon done={done} />
    </button>
  );
}

/** The importance star: a button with `onToggle`, else a picture of the state. */
export function StarButton({ on, onToggle }: { on: boolean; onToggle?: () => void }) {
  if (!onToggle) {
    return (
      <span className={`task-star${on ? " on" : ""}`} role="img" aria-label={on ? "Important" : "Not important"}>
        <StarIcon filled={on} />
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`task-star icon-button${on ? " on" : ""}`}
      aria-label={on ? "Remove importance" : "Add importance"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <StarIcon filled={on} />
    </button>
  );
}
