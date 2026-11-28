import { createRoot } from "react-dom/client";
import { MirrorStore } from "../sync/store.ts";
import { App, AppContext, type AppDeps } from "./App.tsx";
import { createBffFetch } from "./api.ts";
import { createLoader } from "./loader.ts";
import { createSessionClient } from "./session.ts";

// One mirror, session and loader per page. The mirror lives only in memory: a
// reload pulls again, and the session's data_key is not used yet.
const fetchFn: typeof fetch = (input, init) => fetch(input, init);
const store = new MirrorStore();
const session = createSessionClient(fetchFn, { store });
const loader = createLoader(createBffFetch(fetchFn, session), store, session);
const deps: AppDeps = { store, session, loader };

createRoot(document.getElementById("root")!).render(
  <AppContext.Provider value={deps}>
    <App />
  </AppContext.Provider>,
);
