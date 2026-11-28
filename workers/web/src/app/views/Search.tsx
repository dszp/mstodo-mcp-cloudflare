import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import { searchLocal } from "../../sync/smart-lists.ts";
import type { MirrorStore } from "../../sync/store.ts";
import type { BffFetch } from "../api.ts";
import { olderTasks, parseSearchResponse, searchDetailSource, parseTaskResponse, searchPath, searchText } from "../model.ts";
import { type Route, replaceRoute } from "../route.ts";
import { useRemote } from "../use-remote.ts";
import { useStoreKey } from "../use-store.ts";
import { BackIcon } from "./icons.tsx";
import { type RowOptions, TaskCard, TaskRow } from "./TaskRow.tsx";
import { TaskDetail } from "./TaskDetail.tsx";

type SearchRoute = Extract<Route, { view: "search" }>;

const OPTIONS: RowOptions = { showList: true, showMyDay: true, showCompletedDay: false };

/**
 * The results of the search in the address bar (the box is in the sidebar):
 * the mirror's matches, then, once "Search all history" is pressed (all=1 in
 * the URL, so a reload asks again), the server's tasks the mirror lacks under
 * "Older tasks". Everything shown is text from the server or the mirror.
 */
export function SearchPane({
  store,
  bff,
  route,
  today,
  timeZone,
  onBack,
}: {
  store: MirrorStore;
  bff: BffFetch;
  route: SearchRoute;
  today: string;
  timeZone: string;
  onBack: () => void;
}) {
  const tasksV = useStoreKey(store, "tasks");
  const text = searchText(route.q);
  const { q, all, includeCompleted } = route;

  const localIds = useMemo(
    () => searchLocal(store, text, { includeCompleted }).map((t) => t.id),
    [store, text, includeCompleted, tasksV],
  );
  const [remote, retry] = useRemote(bff, all ? searchPath(q) : null, parseSearchResponse);
  const older = useMemo(
    () => (remote.status === "ok" ? olderTasks(remote.data, localIds, store, includeCompleted) : []),
    [remote, localIds, store, includeCompleted, tasksV],
  );
  // Rows link back to this search, with its all and done settings.
  const base = useMemo<Route>(() => ({ view: "search", q, all, includeCompleted }), [q, all, includeCompleted]);

  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: localIds.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 52,
    getItemKey: (i) => localIds[i]!,
    overscan: 8,
  });

  return (
    <main className="list-pane">
      <header className="pane-header">
        <button type="button" className="back" onClick={onBack}>
          <BackIcon /> Lists
        </button>
        <h1 className="list-title">Search</h1>
      </header>
      <label className="search-option">
        <input
          type="checkbox"
          checked={includeCompleted}
          onChange={(e) => replaceRoute({ ...route, includeCompleted: e.target.checked })}
        />{" "}
        Include completed
      </label>
      <div className="task-scroll" ref={scroller}>
        {text === "" ? (
          <p className="empty">Type in the search box to find tasks.</p>
        ) : (
          <>
            {localIds.length === 0 ? (
              <p className="empty">No matching tasks.</p>
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
                    <TaskRow
                      store={store}
                      id={localIds[item.index]!}
                      view={base}
                      today={today}
                      timeZone={timeZone}
                      selected={localIds[item.index] === route.task}
                      options={OPTIONS}
                    />
                  </div>
                ))}
              </div>
            )}
            {!all ? (
              <div className="search-more">
                <button type="button" className="text-button" onClick={() => replaceRoute({ ...route, all: true })}>
                  Search all history
                </button>
              </div>
            ) : remote.status === "loading" ? (
              <p className="empty">Searching all history…</p>
            ) : remote.status === "error" ? (
              <p className="empty">
                Search all history didn't finish.{" "}
                <button type="button" className="text-button" onClick={retry}>
                  Try again
                </button>
              </p>
            ) : older.length === 0 ? (
              <p className="empty">No older tasks match.</p>
            ) : (
              <section aria-label="Older tasks">
                <h3 className="section-heading completed-group">
                  <span>Older tasks</span>
                  <span className="section-count">{older.length}</span>
                </h3>
                {older.map((t) => (
                  <div key={t.id} className="older-row">
                    <OlderRow store={store} t={t} base={base} today={today} timeZone={timeZone} selected={t.id === route.task} />
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function OlderRow({
  store,
  t,
  base,
  today,
  timeZone,
  selected,
}: {
  store: MirrorStore;
  t: Parameters<typeof TaskCard>[0]["t"];
  base: Route;
  today: string;
  timeZone: string;
  selected: boolean;
}) {
  useStoreKey(store, "lists"); // the list name follows a rename
  return <TaskCard store={store} t={t} view={base} today={today} timeZone={timeZone} selected={selected} options={OPTIONS} />;
}

/**
 * The detail pane of a search: a task from the mirror as usual; any other is
 * fetched from the server (GET /tasks/{sid}) and shown from that response
 * alone. It is never added to the store.
 */
export function SearchDetail({
  store,
  bff,
  id,
  today,
  timeZone,
  onBack,
  onOpenAttachment,
}: {
  store: MirrorStore;
  bff: BffFetch;
  id: string;
  today: string;
  timeZone: string;
  onBack: () => void;
  onOpenAttachment: (href: string, name: string) => void;
}) {
  useStoreKey(store, { task: id });
  const source = searchDetailSource(store, id);
  const [remote, retry] = useRemote(bff, source === "server" ? `tasks/${encodeURIComponent(id)}` : null, parseTaskResponse);
  const props = { store, id, today, timeZone, onBack, onOpenAttachment };
  if (source === "store") return <TaskDetail {...props} />;
  if (source === "gone") return <TaskDetail {...props} placeholder={<p className="empty">This task no longer exists.</p>} />;
  switch (remote.status) {
    case "ok":
      return <TaskDetail {...props} task={remote.data} />;
    case "error":
      return (
        <TaskDetail
          {...props}
          placeholder={
            remote.httpStatus === 404 ? (
              <p className="empty">This task no longer exists.</p>
            ) : (
              <p className="empty">
                The task didn't load.{" "}
                <button type="button" className="text-button" onClick={retry}>
                  Try again
                </button>
              </p>
            )
          }
        />
      );
    default:
      return <TaskDetail {...props} placeholder={<p className="empty">Loading…</p>} />;
  }
}
