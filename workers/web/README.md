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
npm run web:dev                   # Vite dev server with hot reload and a fake BFF
npm run web:build                 # build the app into workers/web/dist
npx vite preview --config workers/web/vite.config.ts   # serve the build, with the same fake BFF
npx vitest run --project web      # tests
npx tsc --noEmit -p workers/web   # typecheck the app
npx tsc --noEmit -p workers/web/tsconfig.worker.json   # typecheck the BFF and host
npx tsc --noEmit -p workers/web/tsconfig.engine.json   # typecheck the engine
```

`web:dev` and `vite preview` answer `/bff/*` and `/auth/*` from a fake BFF
(`src/app/dev/fake-bff.ts`) with made-up data, so they need no server and no sign-in. Use
`vite preview` to check the production build (`http://127.0.0.1:4173`).

The real Worker and BFF don't run locally against a server: the Worker answers `421` to any
origin other than its `WEB_ORIGIN` (the deployment's https `base_url`), and the server only
redirects sign-in back to that origin. Test sign-in on a deployed web Worker pointed at a test
server.
