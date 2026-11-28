import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useMemo, useRef, useState } from "react";
import type { MirrorStore } from "../../sync/store.ts";
import { type Accent, type TaskRow as Row, type TaskView, accentOf, splitListName, taskRows } from "../model.ts";
import { useStoreKey } from "../use-store.ts";
import { CompletedSummary, SectionHeading } from "./CompletedGroups.tsx";
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

/**
 * One list's tasks, virtualized: a smart list (SYNC-API 4.10) or a regular
 * list with its completed tasks in a closed "Completed" section. My Day's
 * Completed section starts open, as in the apps.
 */
export function TaskList({
  store,
  view,
  today,
  timeZone,
  selectedTask,
  onBack,
}: {
  store: MirrorStore;
  view: TaskView;
  today: string;
  timeZone: string;
  selectedTask: string | null;
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
      <div className="task-scroll" ref={scroller}>
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
    </main>
  );
}
