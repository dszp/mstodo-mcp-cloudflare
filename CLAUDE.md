# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A single-user, single-tenant **MCP server for Microsoft To Do**, running as one Cloudflare Worker. It exposes ~40 MCP tools (list/task CRUD, checklist items, linked resources, attachments, My Day, search, config) backed by a SQLite-in-Durable-Object cache with Graph delta sync.

## Commands

```bash
npm run dev          # wrangler dev — local Worker using .dev.vars
npm test             # vitest run (all tests, via @cloudflare/vitest-pool-workers)
npm run test:watch   # vitest watch mode
npm run types        # wrangler types — regenerate worker-configuration.d.ts after binding changes
npm run deploy       # wrangler deploy

npx vitest run test/move-task.test.ts          # one test file
npx vitest run -t "reparent"                    # tests matching a name
bash scripts/push-secrets.sh                    # push every secret from .dev.vars to the deployed Worker
```

**Tests need no real credentials or live config.** `vitest.config.ts` points the workers pool at the committed `wrangler.example.jsonc` and supplies fake secrets via miniflare bindings; KV and DO bindings are simulated locally. `test/_test-worker.ts` re-exports only `TodoIndex` (the `MSToDoMCP` agent DO is deliberately excluded — it pulls in the MCP SDK → ajv, which the pool can't resolve).

## Architecture

### Request flow
`src/index.ts` is the only Worker export. It handles `/health` inline, then tries `handleUpload()` → `handleDownload()` → `handleWebhook(req, env, ctx)` (each returns `null` for non-matching paths; `handleWebhook` takes `ctx` because it defers post-202 work to `ctx.waitUntil`), then hands everything else to `OAuthProvider.fetch()` from `@cloudflare/workers-oauth-provider`. The OAuth provider owns `/authorize` + `/auth/microsoft/callback` and routes MCP sessions into the `MSToDoMCP` Durable Object. `index.ts` also exports the cron handler and both DO classes.

### Two Durable Objects (the key topology)
- **`MSToDoMCP`** (binding `TODO_INDEX`, **per-session**) — extends `McpAgent`. Holds the WebSocket session and dispatches tool calls. Registers all tools in `init()`. Owns **no** persistent state; it reads tokens from `TODO_CACHE` KV and delegates all refresh to the singleton.
- **`TodoIndex`** (binding `TODO_INDEX_DO`, **singleton** `idFromName("owner")`) — extends `DurableObject`. Owns the SQLite cache (tasks/lists/sync_state), delta-sync orchestration, and is the **sole** caller of the Microsoft token endpoint. A `#refreshChain` promise serializer funnels every refresh through one chain so concurrent sessions don't create refresh storms; an `#identityGeneration` counter invalidates in-flight refreshes when the user re-authorizes as a different account.

> The wrangler binding for the MCP agent is named `TODO_INDEX`, overriding the SDK's default `MCP_OBJECT`. Without this override the SDK throws `env.MCP_OBJECT is undefined`.

### MCP tool layer — `src/mcp/agent.ts`
All tools live here and are wrapped by `withGraph(name, fn)`: auth preflight → `GraphError`→named-reason mapping (`list_not_found`, `task_not_found`, `rate_limit_exceeded`, …) → `instrument()`. My Day tools additionally use `withSubstrate()`, which gates on `ENABLE_MY_DAY` and builds a `SubstrateClient`. Handlers build results with `src/mcp/result.ts` (`ok()`/`err()` `ToolResult<T>`); `instrument()` converts those to the MCP text envelope and catches unexpected throws as `unexpected_error` (no unhandled rejections escape the tool layer).

### Two Graph clients (intentional)
- `src/graph/client.ts` (`GraphClient`) — `graph.microsoft.com/v1.0`, token audience `graph.microsoft.com`. Standard CRUD + delta + sub-resources.
- `src/graph/substrate-client.ts` (`SubstrateClient`) — `substrate.office.com` (Exchange Online audience), the undocumented endpoint the To Do web app uses. Required because **Graph's `todoTask` has no `CommittedDay` field — My Day is invisible to Graph**. Substrate uses PascalCase Outlook shapes. Also powers **lossless cross-list move** via `reparentTask()` (PATCH `ParentFolderId`), which preserves checklist items / attachments / linked resources / My Day that a Graph create+delete would lose. See `src/mcp/move-task.ts` for the three-stage safety net (reparent → confirm `ParentFolderId` → only fall back to copy/delete if the source is confirmed still present).

Both clients: **host-pin** before attaching the Bearer token (prevents token leak via a malicious `@odata.nextLink`), retry once on 401 after a forced refresh, and handle 429 (Graph: 1 retry; Substrate: 2, EXO throttles harder). Neither holds tokens — they take a `TokenProvider` interface.

### Delta sync & SQLite — `src/cache/index-do.ts`, `src/cache/sql.ts`, `src/graph/delta.ts`
`TodoIndex.runSyncCycle()` syncs the list roster (`$delta` on `/me/todo/lists`) then per-list tasks (incomplete lists first, capped `MAX_PAGES_PER_CYCLE=30`/cycle). `delta.ts` `followToTerminal()` walks `@odata.nextLink` chains into a `DeltaRow[]` union (`removed` | `task`) until `@odata.deltaLink`; a 410 (expired token) triggers a re-baseline. The `alarm()` re-arms itself (2s mid-sync, else `DELTA_SYNC_INTERVAL_MIN`); the `*/15` cron calls `ensureSyncing()` as a heartbeat to re-arm after DO eviction. SQLite tables: `tasks` (Graph `dateTimeTimeZone` flattened to epoch ms), `tasks_fts` (FTS5 external-content mirror kept current by triggers — powers `search_tasks`), `lists`, `sync_state`.

### Auth & the OWNER_EMAIL gate — `src/auth/handler.ts`, `src/auth/microsoft.ts`
PKCE S256 against Entra. Scopes are `Tasks.ReadWrite offline_access User.Read`, plus `https://outlook.office.com/Tasks.ReadWrite` when `ENABLE_MY_DAY=true` (two audiences, one refresh token → both a Graph and a Substrate token). On callback, `isOwner()` checks `/me` `mail`/`userPrincipalName` against the `OWNER_EMAIL` secret and **403s non-matching users before any token is stored**. A changed `/me.id` triggers `wipeIdentityScopedState()` in fail-closed order (DO reset → KV token wipe → identity delete → alias clear). The `AADSTS65001` latch (`#substrateUnavailable`) returns `my_day_unavailable` without re-minting once the EXO scope is found unconsented.

### Config — `src/config/`
Three Zod-validated blobs (`schemas.ts`) read/written to fixed `TODO_CACHE` KV keys (`config:lists`, `config:link_rules`, `config:attachments`) via `loader.ts`, **no in-memory cache** (fresh KV read per tool call). `ListsConfig` drives `classifier.ts` (regex list classification after `stripEmoji()`), `query-scope.ts` (multi-list filtering + `completed`→Graph status enum), and `aliases.ts` (alias→name→id resolution). `link-rules-engine.ts` `runLinkRules()` is pure with DoS guards (8 KB body cap, 50 ms budget); To Do allows exactly one linked resource per task so it stops at first match.

### Observability — `src/log.ts`, `src/observability/instrument.ts`
`log.{debug,info,warn,error}(event, fields)` emits structured JSON (Workers Observability is enabled in `wrangler.jsonc`). `instrument()` emits a `tool` event with `{name, durationMs, ok, reason}`. Both Graph clients redact query strings before logging (delta tokens / `$filter` carry sensitive data).

### Bindings (see `wrangler.jsonc`, types in `src/types.ts`)
- KV: `OAUTH_KV` (PKCE/OAuth state, upload/download capability tokens), `TODO_CACHE` (tokens, the three config blobs)
- DO: `TODO_INDEX` (`MSToDoMCP`), `TODO_INDEX_DO` (`TodoIndex`)
- Secrets: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `OWNER_EMAIL`
- Vars: `TIMEZONE`, `DELTA_SYNC_INTERVAL_MIN`, `LIST_METADATA_SOFT_TTL_SEC`, `SERVICE_BASE_URL`, `ENABLE_MY_DAY`, `ENABLE_DOWNLOAD_LINKS`, `ENABLE_TASK_SUBSCRIPTIONS`, `MY_DAY_SCAN_EVERY_N_CYCLES`, `MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE`

`create_upload_link` mints an unguessable capability token into `OAUTH_KV` (`upload:` prefix); the `/upload` handler (`src/upload/`) burns it on first use, giving the browser an upload surface without the OAuth token.

`mint_download_link` is the inverse (ROADMAP §9): the same capability machinery (`src/upload/tokens.ts`, distinct `download:` prefix, ≤5-min TTL) scoped to one attachment, served by the public `/download` handler (`src/upload/download-handler.ts`, wired in `index.ts` right after `handleUpload`). The handler burns the token **before** the Graph fetch (single-use on first reachable GET, not transactional) and reuses `getAttachmentBytes()` to move bytes server-to-server without the model in the loop. Gated by the `ENABLE_DOWNLOAD_LINKS` var (defaults on; `"false"` disables both the tool and the endpoint).

### Graph change-notification subscriptions — `src/subscriptions/` (ROADMAP §4)
Gated by `ENABLE_TASK_SUBSCRIPTIONS` (default ON; `"false"` disables the public webhook + all subscription creation). Three modules: `gate.ts` (`taskSubscriptionsEnabled`, `webhookUrl`, lifetime/renew/budget constants), `manager.ts` (pure Graph create/renew/delete/list over an injected `GraphClient` — host-pinned, sole-refresher invariant intact), and `webhook-handler.ts` (`handleWebhook`). The `subscriptions` SQLite table (migration **v2**: `subscription_id`/`list_id`/`client_state`/`expiration_ms`) lives in `TodoIndex`, which owns reconcile (`reconcileSubscriptions`, diff roster↔records) + renew (`renewSubscriptions`) — both **budgeted** by `MAX_SUBSCRIPTION_OPS_PER_CYCLE` and called from `runSyncCycle`'s calm-cycle block. `handleWebhook` echoes Graph's `?validationToken` synchronously (DO-free) and acks real notifications `202` within Graph's 3s window, deferring `TodoIndex.onChangeNotification()` to `ctx.waitUntil`. **Invariant — the notification path is read-only toward Microsoft task data:** `onChangeNotification` validates `clientState`, arms the alarm (Graph delta refreshes Graph fields), and does a *targeted* single-task Substrate `getTask` to refresh that task's My Day fields (mark-scan-due fallback for a not-yet-cached task). It issues **zero** mutating Graph/Substrate calls, so it can never emit a `todoTask` notification → no feedback loop. **Delta polling stays mandatory** (no missed-notification safety net for `todoTask`); subscriptions only change *when* a cycle runs.

## Secrets in `.dev.vars`
`scripts/push-secrets.sh` pushes each name to Cloudflare over stdin (never argv). A value may be a literal **or** a 1Password reference `op://<vault>/<item>[/<section>]/<field>`, resolved via the `op` CLI at push time (needs `op signin` or `OP_SERVICE_ACCOUNT_TOKEN`); surrounding quotes are stripped, so 1Password's "Copy Secret Reference" pastes in verbatim.

## Release process

Releases are cut **from `dev`**, then merged/pushed to `main` and tagged. The convention (see prior `Release X.Y.Z: …` commits):

1. Confirm what's pending: `git log --oneline main..dev`.
2. In `CHANGELOG.md`, rename the `## [Unreleased]` heading to `## [X.Y.Z] – YYYY-MM-DD` (en dash `–`, Keep-a-Changelog format, sections ordered Added/Changed/Fixed/…), add any missing entries, and open a fresh empty `## [Unreleased]` above it.
3. Bump `version` in **`package.json`** and the two root entries in **`package-lock.json`** (lines ~3 and ~9 — do **not** touch a dependency that coincidentally shares the version).
4. Commit as `Release X.Y.Z: <theme>`.
5. Tag `vX.Y.Z` and push the branch + tag.

## Conventions & invariants worth preserving
- **Only `TodoIndex` refreshes tokens.** Don't add token-endpoint calls elsewhere; route through the singleton's serializer.
- **Host-pin before attaching a Bearer token** — keep `assertGraphUrl` / `assertSubstrateUrl` in front of every authed request when adding endpoints.
- **The server is strictly single-user.** The `OWNER_EMAIL` 403 gate and identity-change wipe are load-bearing; don't loosen them.
- New tools go through `withGraph` (and `withSubstrate` for My Day) so they inherit auth preflight, error mapping, and instrumentation.
- Graph silently ignores `$expand=attachments`; fetch `/attachments` as a sub-resource collection (`src/graph/todo-resources.ts`).
