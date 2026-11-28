# Potem web client

A read-only web app for Potem, served by its own Cloudflare Worker. Setup and deployment are in
the repository's [DEPLOYMENT.md](../../DEPLOYMENT.md#web-client); the API it reads is
[docs/SYNC-API.md](../../docs/SYNC-API.md).

| Folder | Holds |
|---|---|
| `src/sync` | The sync engine: in-memory mirror, change-feed pull, smart lists, local search. No DOM or framework. |
| `src/bff` | The backend-for-frontend: sealed cookies, OAuth sign-in, the session endpoints and the read-only API proxy. Host-independent. |
| `src/hosts/cloudflare` | The Worker: reads the bindings, checks the configuration, routes to the BFF or the assets. |
| `src/app` | The React app. |
| `spike` | An earlier demo that renders a synthetic feed (`npm run web:spike`). |

## Run it locally

Run these from the repository root.

```bash
npm run web:build                 # build the app into workers/web/dist
npm run dev -- <name>             # the Worker and BFF, for a deployment with "kind": "web"
npm run web:dev                   # Vite dev server for the app alone
npx vitest run --project web      # tests
npx tsc --noEmit -p workers/web   # typecheck the app
npx tsc --noEmit -p workers/web/tsconfig.worker.json   # typecheck the BFF and host
npx tsc --noEmit -p workers/web/tsconfig.engine.json   # typecheck the engine
```

`npm run dev -- <name>` serves the built app, so run `web:build` first and sign in to a real
server. `web:dev` serves the app with hot reload and answers `/bff/*` and `/auth/*` from a fake
BFF (`src/app/dev/fake-bff.ts`) with made-up data, so it needs no server and no sign-in.
