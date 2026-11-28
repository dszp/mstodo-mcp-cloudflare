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
import { SignedOutError } from "./api.ts";
import { type Loader, watchFocus } from "./loader.ts";
import type { TaskView } from "./model.ts";
import { type Route, currentRoute, navigate, subscribeRoute } from "./route.ts";
import { type SessionClient, watchActivity } from "./session.ts";
import { useToday } from "./use-today.ts";
import { Sidebar } from "./views/Sidebar.tsx";
import { TaskDetail } from "./views/TaskDetail.tsx";
import { TaskList } from "./views/TaskList.tsx";

export interface AppDeps {
  store: MirrorStore;
  session: SessionClient;
  loader: Loader;
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
    const stopActivity = watchActivity(session, { target: window, doc: document });
    const stopFocus = watchFocus(loader, window);
    return () => {
      stopActivity();
      stopFocus();
    };
  }, [status, session, loader]);

  switch (status) {
    case "loading":
      return <p className="status-page">Loading your tasks…</p>;
    case "signed_out":
      return <SignedOut />;
    case "error":
      return (
        <main className="status-page">
          <p>Your tasks didn't load. Check your connection, then try again.</p>
          <button type="button" onClick={() => void start()}>
            Try again
          </button>
        </main>
      );
    case "ready":
      return <Ready />;
  }
}

function SignedOut() {
  const returnTo = window.location.pathname + window.location.search;
  return (
    <main className="status-page">
      <h1>Potem</h1>
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
  const { store, session, loader } = useApp();
  const route = useRoute();
  const today = useToday(loader);
  const timeZone = loader.info()?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [sidebarShown, setSidebarShown] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  // One object per shown list, so rows (memoized on it) don't re-render when only ?task changes.
  const smart = route.view === "smart" ? route.list : null;
  const listId = route.view === "list" ? route.id : null;
  const view = useMemo<TaskView | null>(
    () => (smart !== null ? { view: "smart", list: smart } : listId !== null ? { view: "list", id: listId } : null),
    [smart, listId],
  );
  const task = route.view === "search" ? null : (route.task ?? null);
  const pane = task !== null ? "detail" : sidebarShown ? "sidebar" : "list";

  const signOut = () => {
    setSignOutFailed(false);
    session.logout().catch((e: unknown) => {
      console.error("sign-out failed", e);
      setSignOutFailed(true);
    });
  };
  const closeTask = () => {
    if (route.view !== "search") navigate({ ...route, task: undefined });
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
            <button type="button" className="sign-out" onClick={signOut}>
              Sign out
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
          onBack={() => setSidebarShown(true)}
        />
      ) : (
        <main className="list-pane">
          <p className="empty">Search isn't available yet.</p>
        </main>
      )}
      {task !== null && <TaskDetail store={store} id={task} today={today} timeZone={timeZone} onBack={closeTask} />}
    </div>
  );
}
