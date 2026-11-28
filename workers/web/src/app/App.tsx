import {
  type MouseEvent,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { SmartList } from "../sync/feed.ts";
import { listTasks, smartCounts, smartListTasks } from "../sync/smart-lists.ts";
import type { MirrorStore } from "../sync/store.ts";
import { SignedOutError } from "./api.ts";
import { type Loader, watchFocus } from "./loader.ts";
import { type Route, currentRoute, formatRoute, navigate, subscribeRoute } from "./route.ts";
import { type SessionClient, watchActivity } from "./session.ts";
import { useStoreKey } from "./use-store.ts";

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
      return <p>Loading your tasks…</p>;
    case "signed_out":
      return <SignedOut />;
    case "error":
      return (
        <main>
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
    <main>
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

/** A same-page link: a plain click navigates without a reload. */
function RouteLink({ to, children }: { to: Route; children: ReactNode }) {
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={formatRoute(to)} onClick={onClick}>
      {children}
    </a>
  );
}

const SMART_NAMES: Record<SmartList, string> = {
  my_day: "My Day",
  important: "Important",
  planned: "Planned",
  all: "All",
  completed: "Completed",
};

// Placeholder until the real views (Task 7): the smart-list counts, the list
// names and the selected view's task count.
function Ready() {
  const { store, session, loader } = useApp();
  useStoreKey(store, "tasks");
  useStoreKey(store, "lists");
  const route = useRoute();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const today = loader.today();
  const counts = smartCounts(store, { today });

  const shown =
    route.view === "smart"
      ? `${SMART_NAMES[route.list]}: ${smartListTasks(store, route.list, { today }).length} tasks`
      : route.view === "list"
        ? `${store.list(route.id)?.name ?? "Unknown list"}: ${listTasks(store, route.id).length} tasks`
        : `Search for "${route.q}"`;

  const signOut = () => {
    setSignOutFailed(false);
    session.logout().catch((e: unknown) => {
      console.error("sign-out failed", e);
      setSignOutFailed(true);
    });
  };

  return (
    <div>
      <nav>
        <ul>
          {(Object.keys(SMART_NAMES) as SmartList[]).map((list) => (
            <li key={list}>
              <RouteLink to={{ view: "smart", list }}>
                {SMART_NAMES[list]} ({counts[list]})
              </RouteLink>
            </li>
          ))}
        </ul>
        <ul>
          {store.lists().map((l) => (
            <li key={l.id}>
              <RouteLink to={{ view: "list", id: l.id }}>{l.name}</RouteLink>
            </li>
          ))}
        </ul>
        <button type="button" onClick={signOut}>
          Sign out
        </button>
        {signOutFailed && <p>Sign-out didn't finish. Try again.</p>}
      </nav>
      <main>
        <p>{shown}</p>
        <p>Today is {today}.</p>
      </main>
    </div>
  );
}
