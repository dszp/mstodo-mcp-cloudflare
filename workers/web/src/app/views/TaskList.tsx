import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { MirrorStore } from "../../sync/store.ts";
import type { Edits } from "../edits.ts";
import type { Notices } from "../editing.ts";
import {
  type Accent,
  type TaskRow as Row,
  type TaskView,
  accentOf,
  neighborAfterRemoval,
  splitListName,
  taskRows,
} from "../model.ts";
import { replaceRoute } from "../route.ts";
import { useStoreKey } from "../use-store.ts";
import { AddTask } from "./AddTask.tsx";
import { CompletedSummary, SectionHeading } from "./CompletedGroups.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { BackIcon } from "./icons.tsx";
import { SMART_NAMES } from "./Sidebar.tsx";
import { type RowOptions, TaskRow } from "./TaskRow.tsx";

const EMPTY: Record<string, string> = {
  my_day: "Nothing in My Day.",
  important: "No important tasks.",
  planned: "No tasks with a due date.",
  all: "No open tasks.",
  completed: "No completed tasks.",
};

/** True when a key pressed in `el` belongs to it: typing, or pressing a control. */
function keyBelongsTo(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName);
}

/**
 * One list's tasks, virtualized: a smart list (SYNC-API 4.10) or a regular
 * list with its completed tasks in a closed "Completed" section. My Day's
 * Completed section starts open, as in the apps. Every list but Completed
 * ends in the "Add a task" box.
 *
 * Keys, as in the Mac app: Space completes the open task, Delete (Backspace
 * on a Mac keyboard) asks to delete it, and Ctrl/Cmd-N goes to the add box.
 * Space and Delete are left alone while focus is in a text field or on a
 * button, where they type or press.
 */
export function TaskList({
  store,
  view,
  today,
  timeZone,
  selectedTask,
  edits,
  notices,
  onBack,
}: {
  store: MirrorStore;
  view: TaskView;
  today: string;
  timeZone: string;
  selectedTask: string | null;
  edits: Edits;
  notices: Pick<Notices, "add">;
  onBack: () => void;
}) {
  const tasksV = useStoreKey(store, "tasks");
  // The title follows a rename of the list.
  useStoreKey(store, "lists");
  const [completedOpen, setCompletedOpen] = useState(view.view === "smart" && view.list === "my_day");

  const rows = useMemo(
    () => taskRows(store, view, today, { completedOpen }),
    [store, view, today, completedOpen, tasksV],
  );
  const options = useMemo<RowOptions>(
    () => ({
      showList: view.view === "smart",
      showMyDay: !(view.view === "smart" && view.list === "my_day"),
      showCompletedDay: view.view === "smart" && view.list === "completed",
    }),
    [view],
  );

  let title: string;
  let accent: Accent | null = null;
  if (view.view === "smart") title = SMART_NAMES[view.list];
  else {
    const l = store.list(view.id);
    title = l ? splitListName(l.name ?? "Untitled list").title : "List not found";
    accent = accentOf(l?.theme.color);
  }

  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (rows[i]?.kind === "section" ? 40 : 52),
    getItemKey: (i) => {
      const r = rows[i]!;
      return r.kind === "task" ? r.id : `section:${r.key}`;
    },
    overscan: 8,
  });

  const canAdd = !(view.view === "smart" && view.list === "completed");
  const addBox = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "n") {
        if (!addBox.current) return;
        e.preventDefault();
        addBox.current.focus();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || selectedTask === null || keyBelongsTo(e.target)) return;
      const t = store.task(selectedTask);
      if (!t) return;
      if (e.key === " " && !e.repeat) {
        e.preventDefault();
        edits.setCompleted(t.id, t.status !== "completed");
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        setConfirmDelete(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, edits, selectedTask]);

  // After the open task is deleted (here or in the detail pane, which then
  // closes), focus goes to the next row, else the previous, else the list:
  // the deleted row's link is gone and focus would fall to the page. The rows
  // are remembered from while the task was still shown, since the store can
  // drop it a render before the route closes it.
  const taskIds = useMemo(() => rows.flatMap((r) => (r.kind === "task" ? [r.id] : [])), [rows]);
  const lastSelected = useRef(selectedTask);
  const lastIds = useRef(taskIds);
  useEffect(() => {
    const was = lastSelected.current;
    lastSelected.current = selectedTask;
    if (selectedTask !== null && store.task(selectedTask) !== undefined) {
      lastIds.current = taskIds;
      return;
    }
    if (was === null || selectedTask !== null || store.task(was) !== undefined) return;
    const next = neighborAfterRemoval(lastIds.current, was);
    const link = next === null ? null : scroller.current?.querySelector<HTMLElement>(`[data-task="${CSS.escape(next)}"] .task-link`);
    (link ?? scroller.current)?.focus();
  }, [store, selectedTask, taskIds]);

  const deleteTask = (id: string) => {
    setConfirmDelete(null);
    edits.remove(id);
    // The open task is gone: close the detail pane.
    if (id === selectedTask) replaceRoute(view);
  };

  const completedCount = view.view === "smart" && view.list === "completed"
    ? rows.reduce((n, r) => n + (r.kind === "task" ? 1 : 0), 0)
    : null;

  const render = (r: Row): ReactNode =>
    r.kind === "task" ? (
      <TaskRow
        store={store}
        id={r.id}
        view={view}
        today={today}
        timeZone={timeZone}
        selected={r.id === selectedTask}
        options={options}
        edits={edits}
      />
    ) : (
      <SectionHeading section={r} open={completedOpen} onToggle={() => setCompletedOpen((o) => !o)} />
    );

  return (
    <main className="list-pane">
      <header className="pane-header">
        <button type="button" className="back" onClick={onBack}>
          <BackIcon /> Lists
        </button>
        <h1 className={`list-title${accent ? ` accent-${accent}` : ""}`}>{title}</h1>
      </header>
      {completedCount !== null && completedCount > 0 && <CompletedSummary count={completedCount} />}
      <div className="task-scroll" ref={scroller} tabIndex={-1}>
        {rows.length === 0 ? (
          <p className="empty">{view.view === "smart" ? EMPTY[view.list] : "No tasks."}</p>
        ) : (
          <div className="task-rows" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                className="vrow"
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {render(rows[item.index]!)}
              </div>
            ))}
          </div>
        )}
      </div>
      {canAdd && (
        <AddTask
          inputRef={addBox}
          onAdd={(title) => {
            try {
              edits.addTask(title, view);
              return true;
            } catch (e) {
              // Only before the lists load: a smart list adds to the default
              // list. The box keeps the text so it can be added again.
              console.error("adding the task failed", e);
              notices.add({ op: "task.create", sid: "", error: "no_default_list" });
              return false;
            }
          }}
        />
      )}
      {confirmDelete !== null && (
        <ConfirmDialog
          message={`Delete "${store.task(confirmDelete)?.title ?? "this task"}"?`}
          confirmLabel="Delete"
          onConfirm={() => deleteTask(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </main>
  );
}
