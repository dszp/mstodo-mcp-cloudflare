import { createRoot } from "react-dom/client";
import "./styles.css";
import { MirrorStore } from "../sync/store.ts";
import { App, AppContext, type AppDeps } from "./App.tsx";
import { createBffFetch, withTimeout } from "./api.ts";
import { createEditing } from "./editing.ts";
import { createLoader } from "./loader.ts";
import { createSessionClient } from "./session.ts";
import { ErrorBoundary } from "./views/ErrorBoundary.tsx";

// One mirror, session, loader and outbox per page. The mirror lives only in memory: a
// reload pulls again, and the session's data_key is not used yet.
// Every request gives up after 30 s (withTimeout), so a hung one can't hold
// the cross-tab refresh lock.
const fetchFn: typeof fetch = withTimeout((input, init) => fetch(input, init));
const store = new MirrorStore();
const session = createSessionClient(fetchFn, { store });
const bff = createBffFetch(fetchFn, session);
const loader = createLoader(bff, store, session);
// Reading localStorage throws when the browser blocks site data; edits then
// use a client_id for this page only.
let storage: Storage | null = null;
try {
  storage = window.localStorage;
} catch {
  /* no storage */
}
// Created before the app renders: its sign-out listener must run before the
// app's, so the signed-out screen can show how many edits were not sent.
const editing = createEditing({ bff, store, loader, session, storage });
// Closing or reloading the tab while edits wait to be sent asks first: the
// outbox lives in memory only.
window.addEventListener("beforeunload", (e) => {
  if (editing.outbox.pending().length === 0) return;
  e.preventDefault();
  e.returnValue = "";
});
const deps: AppDeps = { store, session, loader, bff, editing };

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary onSignOut={() => session.logout()} onReload={() => window.location.reload()}>
    <AppContext.Provider value={deps}>
      <App />
    </AppContext.Provider>
  </ErrorBoundary>,
);
