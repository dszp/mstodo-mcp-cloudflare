import { type ReactNode, memo } from "react";
import { bodyText } from "../../sync/plain-text.ts";
import type { MirrorStore, MirrorTask } from "../../sync/store.ts";
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
}: {
  store: MirrorStore;
  id: string;
  view: Route;
  today: string;
  timeZone: string;
  selected: boolean;
  options: RowOptions;
}) {
  useStoreKey(store, { task: id });
  // A row that shows its list's name follows a rename. Subscribing here
  // rather than passing the name down: only the ~30 rendered rows subscribe,
  // and TaskList's own "lists" re-render can't reach rows through memo. A
  // row without the name repeats its task key (a no-op second subscription).
  useStoreKey(store, options.showList ? "lists" : { task: id });
  const t = store.task(id);
  if (!t) return null;
  return <TaskCard store={store} t={t} view={view} today={today} timeZone={timeZone} selected={selected} options={options} />;
});

/**
 * A task as a card: completion circle, title, the details line, and the star.
 * The circle and star show state only. `t` need not be in the store (a hit
 * from "search all history"); only its list's name is read from there.
 */
export function TaskCard({
  store,
  t,
  view,
  today,
  timeZone,
  selected,
  options,
}: {
  store: MirrorStore;
  t: MirrorTask;
  view: Route;
  today: string;
  timeZone: string;
  selected: boolean;
  options: RowOptions;
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
    <RouteLink to={{ ...view, task: id }} className={`task-card${selected ? " selected" : ""}${done ? " done" : ""}`} current={selected}>
      <span className="task-circle" role="img" aria-label={done ? "Completed" : "Not completed"}>
        <CircleIcon done={done} />
      </span>
      <span className="task-text">
        <span className="task-title">{t.title}</span>
        {parts.length > 0 && <span className="task-meta">{parts}</span>}
      </span>
      <span className={`task-star${important ? " on" : ""}`} role="img" aria-label={important ? "Important" : "Not important"}>
        <StarIcon filled={important} />
      </span>
    </RouteLink>
  );
}
