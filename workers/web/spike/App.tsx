import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MirrorStore } from "../src/sync/store";
import { listTasks, smartCounts, smartListTasks } from "../src/sync/smart-lists";
import type { SmartList } from "../src/sync/feed";
import { useStoreKey } from "./use-store";

export interface Stats {
  total: number; open: number; scope: string; pages: number; changes: number;
  fetchMs: number; applyMs: number; firstRenderMs: number; totalMs: number;
}

type Sel = { smart: SmartList } | { list: string };
const SMART: [SmartList, string][] = [
  ["my_day", "My Day"], ["important", "Important"], ["planned", "Planned"], ["all", "All"], ["completed", "Completed"],
];

const Row = memo(function Row(p: { store: MirrorStore; id: string; top: number; selected: boolean; onPick: (id: string) => void }) {
  useStoreKey(p.store, { task: p.id });
  const t = p.store.task(p.id);
  if (!t) return null;
  return (
    <div className={`row${p.selected ? " sel" : ""}${t.status === "completed" ? " done" : ""}`} style={{ top: p.top }} onClick={() => p.onPick(p.id)}>
      <div className="t">{t.importance === "high" ? "! " : ""}{t.title}</div>
      <div className="m">{t.due ?? "no due date"}{t.steps.length ? ` · ${t.steps.length} steps` : ""}</div>
    </div>
  );
});

function TaskList(p: { store: MirrorStore; ids: string[]; selected: string | null; onPick: (id: string) => void; onRows: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: p.ids.length, getScrollElement: () => el.current, estimateSize: () => 44, overscan: 10 });
  const items = v.getVirtualItems();
  const reported = useRef(false);
  useEffect(() => {
    if (items.length > 0 && !reported.current) { reported.current = true; p.onRows(); }
  });
  return (
    <div className="pane tasks" ref={el} data-testid="task-scroll">
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {items.map((it) => (
          <Row key={p.ids[it.index]} store={p.store} id={p.ids[it.index]!} top={it.start} selected={p.ids[it.index] === p.selected} onPick={p.onPick} />
        ))}
      </div>
    </div>
  );
}

function Detail({ store, id }: { store: MirrorStore; id: string | null }) {
  useStoreKey(store, { task: id ?? "" });
  const t = id ? store.task(id) : undefined;
  if (!t) return <div className="pane detail">Select a task.</div>;
  return (
    <div className="pane detail">
      <h2>{t.title}</h2>
      {t.steps.length > 0 && <ul>{t.steps.map((s) => <li key={s.id}>{s.checked ? "[x] " : "[ ] "}{s.title}</li>)}</ul>}
      {t.body && <pre>{t.body.content}</pre>}
    </div>
  );
}

export function App({ store, today, stats, onFirstRows }: { store: MirrorStore; today: string; stats: Omit<Stats, "firstRenderMs" | "totalMs">; onFirstRows: () => void }) {
  const listsV = useStoreKey(store, "lists");
  const tasksV = useStoreKey(store, "tasks");
  const [sel, setSel] = useState<Sel>({ smart: "all" });
  const [picked, setPicked] = useState<string | null>(null);
  const [view, setView] = useState<"side" | "list" | "detail">("list");
  const opts = useMemo(() => ({ today }), [today]);
  const counts = useMemo(() => smartCounts(store, opts), [store, opts, tasksV]);
  const lists = useMemo(
    () => [...store.lists()].filter((l) => l.sync !== "reference").sort((a, b) => (a.sort_key ?? "").localeCompare(b.sort_key ?? "") || a.id.localeCompare(b.id)),
    [store, listsV],
  );
  const ids = useMemo(
    () => ("smart" in sel ? smartListTasks(store, sel.smart, opts) : listTasks(store, sel.list)).map((t) => t.id),
    [store, sel, opts, tasksV],
  );
  const listKey = "smart" in sel ? sel.smart : sel.list;
  return (
    <>
      <div className="app" data-view={view}>
        <div className="pane side">
          {SMART.map(([k, label]) => (
            <button key={k} className={"smart" in sel && sel.smart === k ? "sel" : ""} onClick={() => { setSel({ smart: k }); setView("list"); }}>
              <span>{label}</span><span className="n">{counts[k]}</span>
            </button>
          ))}
          <hr />
          {lists.map((l) => (
            <button key={l.id} className={"list" in sel && sel.list === l.id ? "sel" : ""} onClick={() => { setSel({ list: l.id }); setView("list"); }}>
              <span>{l.name ?? "(unnamed)"}</span>
            </button>
          ))}
        </div>
        <TaskList key={listKey} store={store} ids={ids} selected={picked} onPick={(id) => { setPicked(id); setView("detail"); }} onRows={onFirstRows} />
        <Detail store={store} id={picked} />
      </div>
      <button className="back" style={{ position: "fixed", top: 0, right: 0 }} onClick={() => setView(view === "detail" ? "list" : "side")}>Back</button>
      <Footer stats={stats} />
    </>
  );
}

let setFooter: ((s: Stats) => void) | null = null;
export function publishStats(s: Stats): void { setFooter?.(s); }

function Footer({ stats }: { stats: Omit<Stats, "firstRenderMs" | "totalMs"> }) {
  const [s, set] = useState<Stats | null>(null);
  useEffect(() => { setFooter = set; return () => { setFooter = null; }; }, []);
  const f = (n: number) => n.toFixed(1);
  return (
    <footer>
      {`total ${stats.total} · open ${stats.open} · scope ${stats.scope} · pages ${stats.pages} · changes ${stats.changes} · fetch ${f(stats.fetchMs)}ms · apply ${f(stats.applyMs)}ms`}
      {s ? ` · firstRender ${f(s.firstRenderMs)}ms · total ${f(s.totalMs)}ms` : " · rendering..."}
    </footer>
  );
}
