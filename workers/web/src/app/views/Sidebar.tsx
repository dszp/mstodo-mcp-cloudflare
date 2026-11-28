import { type ReactNode, useMemo, useState } from "react";
import type { SmartList } from "../../sync/feed.ts";
import { smartCounts } from "../../sync/smart-lists.ts";
import type { MirrorStore } from "../../sync/store.ts";
import { type SidebarListItem, sidebarTree } from "../model.ts";
import type { Route } from "../route.ts";
import { useStoreKey } from "../use-store.ts";
import { CalendarIcon, CheckCircleIcon, ChevronIcon, FolderIcon, HomeIcon, InfinityIcon, ListIcon, StarIcon, SunIcon } from "./icons.tsx";
import { RouteLink } from "./RouteLink.tsx";
import { SearchBox } from "./SearchBox.tsx";

export const SMART_NAMES: Record<SmartList, string> = {
  my_day: "My Day",
  important: "Important",
  planned: "Planned",
  all: "All",
  completed: "Completed",
};

const SMART_ICONS: Record<SmartList, ReactNode> = {
  my_day: <SunIcon />,
  important: <StarIcon />,
  planned: <CalendarIcon />,
  all: <InfinityIcon />,
  completed: <CheckCircleIcon />,
};

const SMART_ORDER: SmartList[] = ["my_day", "important", "planned", "all", "completed"];

/**
 * The smart lists with their counts, then the lists: the default list, groups
 * (open and closed with a click) and top-level lists in the server's sidebar
 * order, then reference lists. A list's theme colour tints its icon.
 */
export function Sidebar({
  store,
  route,
  today,
  onNavigate,
  footer,
}: {
  store: MirrorStore;
  route: Route;
  today: string;
  onNavigate: () => void;
  footer: ReactNode;
}) {
  const tasksV = useStoreKey(store, "tasks");
  const listsV = useStoreKey(store, "lists");
  const counts = useMemo(() => smartCounts(store, { today }), [store, today, tasksV]);
  const tree = useMemo(() => sidebarTree(store), [store, tasksV, listsV]);
  // Which groups are closed; kept for this page only, as Microsoft keeps none.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const listLink = (l: SidebarListItem, nested = false) => (
    <li key={l.id}>
      <RouteLink
        to={{ view: "list", id: l.id }}
        className={`side-row${nested ? " nested" : ""}`}
        current={route.view === "list" && route.id === l.id}
        onNavigate={onNavigate}
      >
        <span className={`side-icon list-icon${l.accent ? ` accent-${l.accent}` : ""}`}>
          {l.emoji !== null ? <span className="emoji">{l.emoji}</span> : l.icon === "home" ? <HomeIcon /> : <ListIcon />}
        </span>
        <span className="side-name">{l.name}</span>
        {l.count !== null && l.count > 0 && <span className="side-count">{l.count}</span>}
      </RouteLink>
    </li>
  );

  return (
    <nav className="sidebar" aria-label="Lists">
      <SearchBox route={route} onSubmit={onNavigate} />
      <div className="side-scroll">
        <ul className="side-list">
          {SMART_ORDER.map((smart) => (
            <li key={smart}>
              <RouteLink
                to={{ view: "smart", list: smart }}
                className="side-row"
                current={route.view === "smart" && route.list === smart}
                onNavigate={onNavigate}
              >
                <span className={`side-icon smart-${smart}`}>{SMART_ICONS[smart]}</span>
                <span className="side-name">{SMART_NAMES[smart]}</span>
                {/* Completed shows no count, as in the apps. */}
                {smart !== "completed" && counts[smart] > 0 && <span className="side-count">{counts[smart]}</span>}
              </RouteLink>
            </li>
          ))}
        </ul>
        <h2 className="side-heading">Lists</h2>
        <ul className="side-list">
          {tree.top.map((e) =>
            e.kind === "list" ? (
              listLink(e.list)
            ) : (
              <li key={e.id}>
                <button
                  type="button"
                  className="side-row side-group"
                  aria-expanded={!closed.has(e.id)}
                  onClick={() => toggle(e.id)}
                >
                  <span className="side-chevron">
                    <ChevronIcon />
                  </span>
                  <span className="side-icon group-icon">
                    <FolderIcon />
                  </span>
                  <span className="side-name">{e.name}</span>
                </button>
                {!closed.has(e.id) && e.lists.length > 0 && <ul className="side-list">{e.lists.map((l) => listLink(l, true))}</ul>}
              </li>
            ),
          )}
        </ul>
        {tree.reference.length > 0 && (
          <>
            <h2 className="side-heading">Reference</h2>
            <ul className="side-list">{tree.reference.map((l) => listLink(l))}</ul>
          </>
        )}
      </div>
      <div className="side-footer">{footer}</div>
    </nav>
  );
}
