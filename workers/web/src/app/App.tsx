import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { MirrorStore } from "../sync/store.ts";
import { type BffFetch, SignedOutError } from "./api.ts";
import { type Loader, myDayOn, watchFocus } from "./loader.ts";
import { watchLive } from "./live.ts";
import { type TaskView, unsavedEditsText } from "./model.ts";
import { type Route, currentRoute, replaceRoute, subscribeRoute } from "./route.ts";
import { openAttachment, saveWithAnchor } from "./download.ts";
import { type Editing, flushWithin } from "./editing.ts";
import { type SessionClient, watchSession } from "./session.ts";
import { useToday } from "./use-today.ts";
import { SearchDetail, SearchPane } from "./views/Search.tsx";
import { EditStatus } from "./views/Notice.tsx";
import { Sidebar } from "./views/Sidebar.tsx";
import { TaskDetail } from "./views/TaskDetail.tsx";
import { TaskList } from "./views/TaskList.tsx";

export interface AppDeps {
  store: MirrorStore;
  session: SessionClient;
  loader: Loader;
  bff: BffFetch;
  editing: Editing;
}

export const AppContext = createContext<AppDeps | null>(null);

function useApp(): AppDeps {
  const deps = useContext(AppContext);
  if (!deps) throw new Error("App rendered outside AppContext");
  return deps;
}

type Status = "loading" | "signed_out" | "error" | "ready";

export function App() {
  const { session, loader } = useApp();
  const [status, setStatus] = useState<Status>(session.signedOut ? "signed_out" : "loading");

  useEffect(() => session.onSignedOut(() => setStatus("signed_out")), [session]);

  const start = useCallback(async () => {
    setStatus("loading");
    try {
      const info = await session.current();
      if (!info.signed_in) return; // onSignedOut has set the status
      // Opening the page and pressing Try again are activity: without this,
      // the check just made would leave the session unattended (session.ts)
      // and a load that needs a refresh would fail. watchSession isn't
      // running yet to record it.
      session.touch();
      await loader.load();
      if (!session.signedOut) setStatus("ready");
    } catch (e) {
      if (e instanceof SignedOutError || session.signedOut) return;
      console.error("loading failed", e);
      setStatus("error");
    }
  }, [session, loader]);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (status !== "ready") return;
    const stopActivity = watchSession(session, { target: window, doc: document, win: window });
    const stopFocus = watchFocus(loader, window);
    // The push socket says when to pull; the 30 s poll runs while it isn't open.
    const stopLive = watchLive({
      loader,
      session,
      doc: document,
      openSocket: () => new WebSocket(new URL("/bff/socket", location.href).href.replace(/^http/, "ws")),
      schedule: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      random: Math.random,
      log: (e) => console.warn("push", e),
    });
    return () => {
      stopActivity();
      stopFocus();
      stopLive();
    };
  }, [status, session, loader]);

  switch (status) {
    case "loading":
      return <p className="status-page">Loading your tasks…</p>;
    case "signed_out":
      return <SignedOut />;
    case "error":
      return <LoadFailed onRetry={() => void start()} onSignOut={() => session.logout()} />;
    case "ready":
      return <Ready />;
  }
}

/**
 * The load failed. Sign out is the way out when retrying can't help, as
 * when Cloudflare Access in front of the server ended its session; a
 * finished sign-out shows the signed-out page through onSignedOut.
 */
function LoadFailed({ onRetry, onSignOut }: { onRetry: () => void; onSignOut: () => Promise<void> }) {
  const [signOutFailed, setSignOutFailed] = useState(false);
  return (
    <main className="status-page">
      <p>Your tasks didn't load. Check your connection, then try again.</p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>{" "}
      <button
        type="button"
        onClick={() => {
          setSignOutFailed(false);
          onSignOut().catch((e: unknown) => {
            console.error("sign-out failed", e);
            setSignOutFailed(true);
          });
        }}
      >
        Sign out
      </button>
      {signOutFailed && <p className="small">Sign-out didn't finish. Try again.</p>}
    </main>
  );
}

function SignedOut() {
  const { editing } = useApp();
  const returnTo = window.location.pathname + window.location.search;
  // Sign-out drops edits the server hadn't received (editing.ts).
  const unsaved = unsavedEditsText(editing.discarded());
  return (
    <main className="status-page">
      <h1>Potem</h1>
      {unsaved && <p>{unsaved}</p>}
      <a href={`/auth/login?${new URLSearchParams({ return_to: returnTo })}`}>Sign in</a>
    </main>
  );
}

function useRoute(): Route {
  // The URL string is the snapshot: it compares equal while the route is unchanged.
  const url = useSyncExternalStore(subscribeRoute, () => window.location.pathname + window.location.search);
  return useMemo(() => currentRoute(), [url]);
}

/**
 * The three panes: sidebar, task list, task detail. Below 900 px one shows at
 * a time (styles.css): the detail when a task is open, else the sidebar or the
 * list, with a back control on each.
 */
function Ready() {
  const { store, session, loader, bff, editing } = useApp();
  const route = useRoute();
  const today = useToday(loader);
  // Pending edits are shown against the owner's today ("due today", My Day).
  useEffect(() => editing.refreshContext(), [editing, today]);
  const timeZone = loader.info()?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const myDay = myDayOn(loader.info());
  const [sidebarShown, setSidebarShown] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  // One object per shown list, so rows (memoized on it) don't re-render when only ?task changes.
  const smart = route.view === "smart" ? route.list : null;
  const listId = route.view === "list" ? route.id : null;
  const view = useMemo<TaskView | null>(
    () => (smart !== null ? { view: "smart", list: smart } : listId !== null ? { view: "list", id: listId } : null),
    [smart, listId],
  );
  const task = route.task ?? null;
  const pane = task !== null ? "detail" : sidebarShown ? "sidebar" : "list";

  const [signingOut, setSigningOut] = useState(false);
  const signOut = () => {
    setSignOutFailed(false);
    setSigningOut(true);
    // Unsent edits get up to 3 s to go first (pressing the button has
    // already blurred and saved an open edit box); what is still unsent is
    // then discarded and counted on the signed-out screen.
    flushWithin(editing.outbox)
      .then(() => session.logout())
      .catch((e: unknown) => {
        console.error("sign-out failed", e);
        setSignOutFailed(true);
      })
      .finally(() => setSigningOut(false));
  };
  const onOpenAttachment = (href: string, name: string) => {
    void openAttachment(session, href, name, saveWithAnchor(document));
  };
  const closeTask = () => {
    // Replaced, not pushed: closing a task shouldn't grow the history stack.
    replaceRoute({ ...route, task: undefined });
  };

  return (
    <div className="app" data-pane={pane} data-detail={task !== null ? "open" : "closed"}>
      <Sidebar
        store={store}
        route={route}
        today={today}
        onNavigate={() => setSidebarShown(false)}
        footer={
          <>
            <button type="button" className="sign-out" onClick={signOut} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
            {signOutFailed && <p className="small">Sign-out didn't finish. Try again.</p>}
          </>
        }
      />
      {view !== null ? (
        <TaskList
          key={view.view === "smart" ? view.list : view.id}
          store={store}
          view={view}
          today={today}
          timeZone={timeZone}
          selectedTask={task}
          edits={editing.edits}
          notices={editing.notices}
          myDay={myDay}
          onBack={() => setSidebarShown(true)}
        />
      ) : (
        route.view === "search" && (
          <SearchPane
            store={store}
            bff={bff}
            route={route}
            today={today}
            timeZone={timeZone}
            edits={editing.edits}
            onBack={() => setSidebarShown(true)}
          />
        )
      )}
      {task !== null &&
        (route.view === "search" ? (
          <SearchDetail
            store={store}
            bff={bff}
            id={task}
            today={today}
            timeZone={timeZone}
            onBack={closeTask}
            onOpenAttachment={onOpenAttachment}
            edits={editing.edits}
            myDay={myDay}
          />
        ) : (
          <TaskDetail
            store={store}
            id={task}
            today={today}
            timeZone={timeZone}
            onBack={closeTask}
            onOpenAttachment={onOpenAttachment}
            edits={editing.edits}
            myDay={myDay}
            onDeleted={closeTask}
          />
        ))}
      <EditStatus outbox={editing.outbox} notices={editing.notices} />
    </div>
  );
}
