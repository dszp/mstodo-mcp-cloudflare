# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] – 2026-05-25

### Added
- **Microsoft To Do "My Day" support (opt-in)** via the undocumented Substrate endpoint
  (`https://substrate.office.com/todob2/api/v1/`), which Microsoft Graph does not expose. Three
  new MCP tools — `add_to_my_day`, `remove_from_my_day`, `list_my_day_tasks` — gated behind a new
  `ENABLE_MY_DAY` var (default `"false"`; existing deployments are unaffected when off). Requires
  the **Office 365 Exchange Online `Tasks.ReadWrite`** delegated permission added via the Entra
  app **Manifest** (resource `00000002-0000-0ff1-ce00-000000000000`, scope GUID
  `6b49b74d-642f-4417-a6b4-820576845707`) and a fresh `/authorize`. Empirically verified that a
  third-party app with this delegated scope is sufficient — no `Todo-Internal.ReadWrite` or
  first-party-client impersonation. See `DEPLOYMENT.md` → "My Day support".
- **`SubstrateClient`** (`src/graph/substrate-client.ts`) — a thin client for the Exchange Online
  resource (audience `https://outlook.office.com`). Holds no token logic: it asks the singleton
  `TodoIndex` DO for a substrate access token, injects `Authorization` + `x-anchormailbox`
  (`OID:{oid}@{tid}`, captured at OAuth callback from the access-token `tid` claim), and retries
  once on `401`. Host-pinned to `substrate.office.com`. Tolerant response parsing (the collection
  envelope varies across folders: `value`, `Value`, bare array, or absent).

### Changed
- **Token refresh is now resource-aware while preserving the sole-refresher invariant.** The
  `TodoIndex` DO mints both Graph (audience `graph.microsoft.com`) and Substrate (audience
  `outlook.office.com`) access tokens from the one shared, rotating refresh token. Refreshes are
  serialized on a single chain (only one `/token` call spends the rotating refresh token at a
  time) and coalesced per-resource. The Substrate access token is cached in DO memory only; the
  rotated refresh token is persisted back to `tokens:owner` without clobbering the Graph token.
  When `ENABLE_MY_DAY=true`, `/authorize` widens to a single combined-consent screen covering both
  resources.
- **`config-examples/link-rules.json` updated to match the 0.2.1/0.2.2 engine.** Dropped the
  removed `max_links_per_task` field from every rule, added `external_id_template` (required for
  Microsoft To Do to render a link as a clickable row), and rewrote the header comments to
  describe the current semantics (one linked resource per task, first matching rule wins, no
  post-run URL dedup). The generic `psa-ticket` example is now a concrete `autotask-ticket`
  example matching the live config's formatting, with the server zone genericized to
  `<your-zone>`.

### Notes
- Two findings from live testing corrected the original spec (`PLAN-MY-DAY.md`): **`PostponedDay`
  is not cosmetic** — a task with `PostponedDay == today` is suppressed from My Day even with
  `CommittedDay` set, so `add_to_my_day` clears it; and **`list_my_day_tasks` fans out
  sequentially** because EXO's per-mailbox `MailboxConcurrency` cap rejects parallel per-folder
  reads with `429 ApplicationThrottled` (the tool also honors `Retry-After` and skips/logs a
  failing folder rather than aborting). `CommittedDay` is sent as a bare date computed in the
  Worker's `TIMEZONE`; there is no timezone bug (the server stores it at UTC midnight and clients
  render it on the correct local day). Runtime auto-disable: if the EXO scope isn't
  consented/granted, the tools return `my_day_unavailable` (on `AADSTS65001`/`403`) instead of a
  raw error, independent of the flag.

## [0.2.2] – 2026-05-25

### Fixed
- **One linked resource per task** (Microsoft To Do platform limit). Graph rejects any
  second linked resource on a task with HTTP 400 `"Linked Resource already exists"` /
  innerError `LinkedResourceSizeExceeded`, regardless of payload. The engine previously
  generated multiple matches per task, so only the first succeeded and the rest 400'd — e.g.
  a task already carrying an Autotask ticket link could never also get an Obsidian note link.
  Rules now create **at most one linked resource per task**: the **first matching rule wins**
  (rule array order is the priority), with title matched before body. If a task already
  carries any linked resource — a prior rule link, a manually-added one, or Outlook's built-in
  "Open in Outlook" on flagged-email tasks — the match is **skipped and the existing link is
  never replaced**.

### Changed
- **Removed the per-rule `max_links_per_task` field.** The platform caps linked resources at
  one per task, so the field had no real effect. Previously-stored configs that still include
  it are accepted (the field is ignored on load).
- **`extract_links`** now reports matches it could not create because a link already exists in
  `skipped` (reason `todo_one_linked_resource_per_task`) instead of `failed`; `skipped` entries
  are now `{ match, reason }` objects. `dry_run` surfaces at most one match. The underlying
  Graph error body is now included in `failed[].error` for diagnosability (previously only the
  bare `graph_400` status survived).

## [0.2.1] – 2026-05-25

### Fixed
- **Link-rule linked resources now render as clickable rows in Microsoft To Do.** The client
  only renders a `linkedResource` when it carries an `externalId`; rule-created links omitted
  the field, so e.g. Autotask ticket links never appeared in the client despite a valid `webUrl`
  (they showed for n8n-created tasks, which set `externalId`). Both write paths — the
  `extract_links` tool and the automatic run after `create_task`/`update_task` — now send
  `externalId` on every linked resource.

### Added
- **`external_id_template`** field on link rules (uses `$1`, `$2`, … capture groups like
  `url_template` and `display_template`). When omitted, `externalId` defaults to the matched
  text — the same fallback as `display_template` — so every rule-created link renders without
  requiring per-rule opt-in.

## [0.2.0] – 2026-05-24

### Added
- **Web-based attachment upload** — a new `create_upload_link` MCP tool plus a public
  (non-OAuth) `/upload` endpoint. The tool mints a short-lived (default 15 min, max 30),
  single-use link scoped to one specific task; the user opens it in a browser and the file
  bytes go straight from the browser to the Worker and on to Microsoft Graph — never through
  the model. Inline POST for ≤ 3072 KiB, chunked Graph upload-session (4 MiB ranges) for
  larger files up to 25 MB. Single-file links (baked `filename`) or batch links (up to
  `max_files`, 1–10, default 5). The upload page labels the destination by task title and list
  name (resolved from the index at mint time), not the opaque Graph task id. New module
  `src/upload/{tokens,sniff,graph-upload,handler,page}.ts`.
- **Exact-duplicate detection.** Before attaching, the Worker lists the task's existing
  attachments and skips any uploaded file whose content (SHA-256) matches one already present,
  plus within-batch de-duplication. Only the duplicate files are skipped; the rest attach.
  Comparison is by **content hash, not Microsoft's attachment `size` field** — that field is the
  Exchange *storage* size (~1.1–1.3× the raw byte length), so it never equals an uploaded file's
  byte length; candidates are fetched and hashed up to a storage-size cap to bound downloads.
  Uploads larger than 6 MiB fall back to name matching (downloading the whole existing attachment
  to hash it is impractical, and Graph rejects duplicate names on the upload-session path anyway).
- **`get_attachment` returns images as a native MCP `image` content block** (rendered inline by
  the client) alongside the JSON metadata block, instead of only base64 inside the JSON text.
  `contentBytes` is omitted from the metadata block for images so the base64 doesn't traverse the
  model's context twice. Non-image attachments are unchanged (text + base64).
- **`SERVICE_BASE_URL`** var (in `wrangler.jsonc`) — the Worker's public origin, used to build
  upload links and the only configuration needed to enable web uploads.

### Removed
- **`create_attachment` tool** (inline base64 passed in the tool call). Real files can't
  practically travel through an MCP tool call (the model's per-call argument budget is a few KB),
  so all but trivial uploads failed before Graph was reached. Superseded by the web-upload flow
  above. `list_attachments` and `get_attachment` are unchanged; the delete tool is renamed
  (below).

### Changed
- **Renamed the `delete_attachment` tool to `remove_attachment`** (same arguments and behavior).
- **`config:attachments` `max_inline_bytes`** is now the web-upload inline-vs-session cutover
  (files at or below it attach inline, larger ones via a chunked upload-session) rather than a
  hard reject threshold.

### Security
- Upload links are **unguessable capability tokens** — a 256-bit CSPRNG id whose task scope is
  stored in `OAUTH_KV` under a TTL. Verification is a KV lookup, expiry is the TTL, single-use is
  enforced by deleting the entry on first use (burned before the attach runs, so a leaked or
  retried link can't replay). The id reveals nothing about its target, and there is **no signing
  key or shared secret** to manage. The `/upload` POST is multipart-only (rejects urlencoded/
  cookie-based CSRF), and the Graph upload-session URL is host-pinned to `graph.microsoft.com`
  before the owner's bearer token is attached to any chunk PUT.

## [0.1.1] – 2026-05-24

### Fixed
- **List classification dropped Fitzpatrick skin-tone modifiers.** `stripEmoji`
  removed `Extended_Pictographic` glyphs but not `Emoji_Modifier` code points
  (U+1F3FB–U+1F3FF), so a list named like `👨🏻 INTERNAL TECH 👨🏻` retained a
  stray `🏻` after stripping and fell through to `unclassified`. The strip now
  also covers `\p{Emoji_Modifier}` — deliberately not the broader
  `Emoji_Component`, which would also drop ASCII digits and break names like
  `90 ROCKS`. Fixes both `classifyList` and alias display-name matching
  (`resolveListId`), which share `stripEmoji`.

## [0.1.0] – 2026-05-24

First public release.

### Added (Phase 5)
- **`TodoIndex` Durable Object** (binding `TODO_INDEX_DO`, singleton via
  `idFromName("owner")`, migration `v2`) — the single source of truth for Microsoft
  To Do state: SQLite `tasks` + `tasks_fts` (FTS5 mirror) + `lists` roster +
  `sync_state` (delta cursors).
- **Resumable delta sync** — alarm-driven, budget-bounded loop applies Graph
  `/delta` pages (roster-first, per-list tasks). 410 → purge + re-baseline;
  429/503 → transient backoff (cursor preserved, fast re-arm); per-list errors
  isolated. A Worker `scheduled()` cron heartbeat (`*/15`) re-arms the alarm.
- **`graph/delta.ts` `followToTerminal`** — follows `@odata.nextLink` to a
  `@odata.deltaLink` within a page budget; unions full-task and `@removed` rows.
- **Bulk query / search / aggregation / ops tools**: `query_tasks` (filters +
  ISO/relative dates + keyset pagination), `search_tasks` (FTS5 across lists/body),
  `find_task_list` (PK lookup, no enumeration), `get_pending_across_lists`,
  `get_recently_completed`, `sync_status` (per-resource health), `resync`.
- **Optional `list` on task-level tools** — resolved via the DO's `findListForTask`
  when omitted (`get_task`, checklist/linked-resource/attachment tools).
- Utilities: `stripHtml`, `parseDateInput` (ISO + relative `±Nd`), keyset cursor
  encode/decode.

### Changed (Phase 5)
- **KV reduced to tokens + config.** The DO is now the source of truth for tasks
  and the roster; the `lists:all` / `tasks:{listId}` / `etag:{listId}` KV keys are
  **removed**. Dead `kv-store.ts` cache helpers deleted.
- **Reads served from the DO** (`list_lists` / `get_list` / `list_tasks` / alias
  resolution / classifier) with a cold-start live-Graph fallback while the index
  warms; `list_tasks` emits DO keyset cursors (cold fallback returns one live-Graph
  page with no cursor, so the two cursor spaces never mix).
- **Token refresh centralized in the DO** (sole refresher, global single-flight);
  the per-session agent delegates near-expiry refreshes to it.
- **Mutations propagate to the DO** best-effort (`upsertTask`/`deleteTask`/
  `upsertList`/`deleteList`/`setTaskFlags`).

### Security (Phase 5)
- **Identity-change wipe now clears the DO too.** `TodoIndex.resetIdentity()` drops
  all tasks/roster/`sync_state` and cancels the sync alarm; `wipeIdentityScopedState()`
  calls it alongside the KV token/identity deletes (fail-closed before `storeTokens`)
  so two Microsoft accounts' data can never mix in the index.

### Security (post-Phase 5 hardening — from the close-out review)
- **Graph host pinned (H1).** `GraphClient.fetchWithRetry` rejects any URL that isn't
  `https://graph.microsoft.com` before attaching the owner Bearer token, so a hostile
  or malformed `@odata.nextLink`/`deltaLink` can't exfiltrate it.
- **Logged Graph URLs redacted (H2).** `graph_401_refresh`/`graph_429_retry` now log
  origin + path only, keeping `$skiptoken`/`$deltatoken` continuation tokens out of logs.
- **Identity wipe ordered fail-closed (H3).** `wipeIdentityScopedState` wipes the DO
  first, then deletes the KV tokens, then the identity marker LAST (replacing the
  concurrent `Promise.all`), so a mid-wipe failure re-wipes on the next `/authorize`
  rather than mixing the new baseline with leftover old-account rows.
- **In-flight token refresh generation-guarded (H4).** A token refresh that resolves
  after an identity switch is discarded (`#identityGeneration` snapshot) instead of
  clobbering the new identity's tokens.

### Added (config clearing + per-list sync control + classification filtering)
- **Per-list sync control** (`config:lists.no_sync`, `sync_flagged_emails`): exclude
  lists from delta sync, matched by `wellknownListName` or Graph list ID. The list
  stays in the roster and on-demand-readable (live-Graph cold fallback) but is not
  indexed. **`flaggedEmails` is skipped by default** (a built-in always-on skip, not a
  clobberable Zod default; re-enabled only by `sync_flagged_emails: true`) to conserve
  the daily rows-written budget and keep full-text search clean. The DO sync loop
  enforces the skip and **self-heal-purges** any previously-indexed rows + `sync_state`
  for a now-skipped list (idempotent, guarded — zero writes in steady state). Skipped
  lists report `sync_disabled` in `sync_status` and are excluded from `all_idle`.
- **Classification filtering on `query_tasks` and `search_tasks`** — optional `types`
  (include) and `exclude_types` (exclude) over list classifications, plus a `completed`
  boolean convenience (mutually exclusive with `status` → `conflicting_status_filter`).
  `exclude_types:["excluded"]` drops flagged-email/excluded noise from search **without
  deleting any rows**. Resolved agent-side via pure helpers (`resolveListScope`,
  `resolveStatusFilter`) reducing to the existing DO `lists`/`status` filters — no DO or
  SQLite schema change. An empty resolved scope returns empty results (never widens to
  all lists).

### Changed (config clearing + per-list sync control)
- **`set_list_config` now merges** (omitted fields preserved) and accepts `no_sync` +
  `sync_flagged_emails`; `patterns` is now optional. After writing it calls the DO's
  `ensureSyncing()` so the next cycle reconciles promptly. `get_list_config` reports the
  sync policy. `set_list_alias` now preserves `no_sync`/`sync_flagged_emails` (previously
  re-applied their defaults, silently wiping them).
- **Identity-change wipe clears `config:lists.aliases`.** `wipeIdentityScopedState` now
  clears aliases (best-effort, after the H3 fail-closed critical deletes) — stale aliases
  point at the prior account's list IDs and would resolve to dead IDs → Graph 404.
  `patterns` and `no_sync` are preserved (account-independent intent).

### Notes — config/sync-control smoke (live Worker, 2026-05-24)
- Deployed `mstodo-mcp` version `2edd7c29-f1b2-4b9f-96a2-88222dfe640c` (account on the
  Workers **Paid** plan; cron `*/15` firing `outcome:"ok"`; OAuth + DO-write path
  healthy — the earlier `Exceeded allowed rows written` 500s were all from a *separate*
  `obsidian-mcp` worker on the shared free-tier budget, not this Worker).
- **Pre-seed verified (Migration):** `get_list_config` → `sync_flagged_emails:true`,
  `no_sync:[]`; `sync_status` → `all_idle:true`, 38 lists / 11,721 tasks, and the
  `flaggedEmails` resource reads `status:"idle"`, `row_count:8926` (retained, NOT
  `sync_disabled`) — the 8,926 flagged rows kept exactly as the owner chose.
- **Feature C verified live:** `query_tasks({types:["excluded"]})` → only Flagged-Emails
  rows; `{types:["todo"]}` → only the Tasks list; `{types:["excluded"],exclude_types:["excluded"]}`
  → `count:0` (empty-scope guard holds — does NOT widen to all); `{completed:true}` →
  completed only; `{completed:false,status:[...]}` → `conflicting_status_filter`.
  `search_tasks("survey")` → 25 hits dominated by flagged-email noise;
  `search_tasks("survey",exclude_types:["excluded"])` → 7 hits, all from real task lists,
  zero flagged — clean search while the rows stay indexed.
- **Feature B.5 write path verified:** `set_list_config({no_sync:[fake id]})` round-tripped
  via `get_list_config` and **preserved `sync_flagged_emails:true`** (the set_list_config /
  set_list_alias merge-preservation fix), then restored to `no_sync:[]`.

### Notes — Phase 5 smoke (live Worker, 2026-05-24)
- Deployed `mstodo-mcp` version `deeb49b6` to account `b19a1c…` (migration `v2`
  applied; cron `*/15` active; dry-run + 43/43 vitest + `tsc` clean pre-deploy).
- Verified live **this session** (existing connected MCP tool surface):
  `whoami` → owner identity correct; `list_lists` → `source:"graph_cold"` (cold
  fallback armed `ensureSyncing()`), then `source:"index"` once the roster baseline
  drained (DO-ordered); `list_tasks` → `source:"index"` with a DO **keyset** cursor
  and current task state (a prior rename reflected). Confirms the DO read path,
  cold-start fallback, baseline drain, and Task 9 migration.
- **New-tool smoke — all 7 PASSED** (fresh MCP session, tools re-fetched):
  `sync_status` → `all_idle:true` (3 lists / 11 tasks; drain confirmed pre & post);
  `query_tasks` → `source:"index"`, status/importance filters narrow correctly,
  relative dates accepted, keyset `next_cursor` round-trips to a distinct page 2,
  and a bad date returns the structured `invalid_date` error; `search_tasks` → FTS5
  `source:"index"`, a boolean `OR` query matched **across 3 distinct lists** and
  `title:` column scoping narrowed to the one matching title, malformed query returns
  `invalid_search_query`; `find_task_list` → index PK hit → `{list_id, "Tasks"}`,
  bogus id → `task_not_found`; `get_pending_across_lists` → 3 open `todo` tasks (the
  3 `notStarted` in the sole todo-classified list "Tasks"; Billing/Future Projects
  correctly excluded as unclassified). The intended n8n `Get Bulk Action Tasks by
  Status` cross-check baseline was unavailable — that n8n subworkflow threw its own
  internal error (`round can't be used on null value`), independent of this Worker.
  `get_recently_completed` (30 d) → 2 completed, completed-desc;
  `resync` (single list via `tasks` alias) → re-baseline rebuilt the list to its
  same 8 rows and the index drained back to `all_idle:true`. Confirms the DO
  query/search/aggregation/health/ops surface end-to-end on the live Worker.

### Added (Phase 4)
- `ListsConfig` Zod schema (`config:lists`) — ordered regex patterns for classifying
  lists as `todo | reference | excluded`, plus an alias map (`alias → Graph list ID`).
- `loadListsConfig` / `storeListsConfig` KV loaders for `config:lists`.
- `classifier.ts` — pure `classifyList(displayName, config)` function; strips emoji
  and surrounding whitespace before matching patterns case-insensitively.
- `aliases.ts` — `resolveListId(input, config, env)`: resolves alias → display-name
  → raw Graph ID passthrough in that order.
- `get_list_config` tool — returns current patterns and alias map with display names
  resolved from the list cache where available.
- `set_list_config` tool — replaces the pattern list; validates all patterns compile
  as JS RegExp before writing to KV.
- `set_list_alias` tool — adds or updates a single alias (`alias → Graph list ID`);
  validates the target list exists in the cached roster; multiple aliases may point
  to the same list (e.g. `"finance"` and `"legal"` → same list).
- `list_lists` now accepts an optional `type` filter (`todo | reference | excluded |
  unclassified`) and annotates each list with its computed `type` when patterns are
  configured.
- Alias resolution wired into every list-targeting tool parameter: `create_task`,
  `list_tasks`, `get_task`, `update_task`, `delete_task`, `get_list`, `update_list`,
  `delete_list`, `move_task` (`from_list`/`to_list`), `extract_links`, and all
  checklist-item, linked-resource, and attachment tools. The `list_id` parameter is
  now named `list` and accepts alias, emoji-stripped display name, or raw Graph list ID.
- `config-examples/` directory — sanitized example JSON files for `lists.json`,
  `link-rules.json`, and `attachments.json` with `_comment` annotations and
  `<placeholder>` values for owner-specific fragments.

### Notes — Phase 4 smoke (live Worker, 2026-05-24)

- All 8 smoke steps passed; alias resolution verified on both write (`create_task`,
  `delete_task`) and read (`list_tasks`) paths via the `tasks` alias.
- `get_list_config` returned 2 patterns and 0 aliases before alias setup, matching
  the seeded `config:lists` KV value exactly.
- `list_lists` type filter confirmed: `type=todo` returned "Tasks"; `type=unclassified`
  returned "Billing" and "Future Projects"; `type=excluded` returned 0 lists — the
  `Flagged Emails` pattern is wired but unverifiable end-to-end (no matching list in
  this account).
- `set_list_config` round-trip: added a third pattern (`^Billing$` → reference),
  verified `get_list_config` reflected 3 patterns with aliases preserved, then restored
  to the 2-pattern seed.
- `tasks` alias left in remote KV as a live working alias (intentional).

### Added
- Microsoft Entra OAuth 2.0 + PKCE upstream auth flow on `/authorize` →
  `/auth/microsoft/callback`, brokered to Claude.ai via
  `@cloudflare/workers-oauth-provider`.
- `OWNER_EMAIL` gate — rejects any signed-in Microsoft account whose
  `mail` / `userPrincipalName` doesn't match the configured owner,
  with no persistent state written for rejected attempts.
- Identity-change auto-wipe — when `/me.id` differs from the previously
  stored owner identity, `TODO_CACHE` per-identity rows are cleared
  before the new tokens are stored, preventing silent cross-account
  data mixing.
- `whoami` tool — returns `{id, displayName, mail, userPrincipalName}`
  of the authenticated owner. Smoke-test surface for OAuth + Graph.
- Single-flight token refresh on the McpAgent — concurrent tool calls
  share one in-flight `/token` refresh promise instead of racing.
- `scripts/push-secrets.sh` — reads `.dev.vars` and pipes each value
  over stdin to `wrangler secret put` so secrets never appear in
  argv, env, scrollback, or AI transcripts.
- `README.md` (initial scope) — operational reset directions across
  three scopes (soft / credential rotation / clean slate).

### Changed
- DO binding `TODO_INDEX` is now explicitly passed to
  `MSToDoMCP.serve("/mcp", { binding: "TODO_INDEX" })`; without this,
  agents/mcp defaults to `env.MCP_OBJECT` (undefined) and throws 1101
  on first `/mcp` request.
- KV namespace title for the workers-oauth-provider state is now
  `OAUTH_KV_MSTODO` (binding name remains `OAUTH_KV`) to avoid
  collisions with sibling Workers on the same account that use the
  generic `OAUTH_KV` binding name.

### Removed
- `src/auth/consent-page.ts` — single-user, gate-based auth means no
  in-Worker consent UI is needed (Microsoft + Claude.ai's own DCR
  consent screens are sufficient).
- Phase 0.5b smoke probes (`src/mcp/tools/smoke.ts` and the four
  `smoke_*` MCP tool registrations) — research complete, findings
  folded into Phase 2 schemas, Phase 3 attachment endpoint pinning,
  and Phase 5 delta-sync invariants. Captured in the canonical plan's
  Phase 0.5b Findings Appendix; probe code recoverable from git
  history at commit `25cbc94`.

### Added — Phase 2 (read-only Graph surface)
- `list_lists`, `get_list`, `list_tasks`, `get_task` MCP tools. Pagination
  on `list_tasks` is live against Graph (`$top` + `@odata.nextLink`); the
  `next_cursor` returned to callers is the opaque Graph nextLink URL,
  prefix-validated against `https://graph.microsoft.com/v1.0/me/todo/lists/`.
  See README §Design decisions to revisit for the tradeoff.
- `GraphClient` (`src/graph/client.ts`) — typed Microsoft Graph wrapper with
  conditional GET (`getJsonConditional`), 401-refresh-retry-once via an
  injected `TokenProvider`, 429 `Retry-After` honoring (30 s cap, 1-retry
  budget), 5xx → `GraphError` throw, Zod schema validation on 200, and a
  `getAllPages<T>` helper for OData paginated collections.
- `TokenProvider` interface — decouples `GraphClient` from the McpAgent
  class. The agent implements it; single-flight refresh discipline stays on
  the Durable Object instance.
- `withGraph(tool, fn)` helper on the agent — centralizes the
  not-authenticated pre-flight, `GraphError` → `errResponse(graph_${status})`
  mapping, and `instrument()` wrapping for each read tool. `whoami` pre-dates
  it and stays inline.
- KV cache helpers (`src/cache/kv-store.ts`) — `getCachedLists` /
  `putCachedLists` / `getCachedTasks` / `putCachedTasks` / `getEtag` /
  `putEtag` / `invalidateList` / `invalidateLists` plus
  `LISTS_SOFT_TTL_MS`. `tasks:{listId}` and `etag:{listId}` are populated
  by Phase 5 delta sync; Phase 2 read tools do not write them.
- 15-minute soft-TTL caching of `lists:all` with stale-cache fallback up to
  5× TTL on transient Graph failures (`lists_stale_fallback` log event).
- Zod schemas in `src/graph/types.ts` for `TodoTaskList`, `TodoTask`,
  `ChecklistItem`, `LinkedResource`, and an `Attachment` discriminated
  union (`taskFileAttachment` | `taskReferenceAttachment`). All object
  schemas use `.passthrough()` so future `@odata.*` annotations survive
  parse.
- Friendlier id-error mapping on `get_task` and `list_tasks`: Graph's
  `400 ErrorInvalidIdMalformed` (syntactically invalid id) joins 404 in
  mapping to `task_not_found` / `list_not_found`.
- README §Design decisions to revisit — documents the `list_tasks`
  live-pagination vs snapshot-cache tradeoff with revisit triggers.

### Fixed — Phase 2
- Identity-change auto-wipe now clears `lists:all` (the only Phase 2
  cache key with a per-identity writer so far). Without this, re-authorizing
  as a different M365 account between now and Phase 5 would surface the
  previous identity's task lists to the new identity. Caught by the
  Phase 2 close-out `advisor()` review.

### Added — Phase 3 (full write surface + config infrastructure)

- `GraphClient` mutations — `postJson` (POST → 201), `patchJson` (PATCH → 200,
  optional `If-Match`), `deleteResource` (DELETE → 204, optional `If-Match`).
  Same 401-refresh-retry-once, 429 `Retry-After` honoring, Zod-validate-on-200
  invariants as the Phase 2 read path.
- Task mutation tools: `create_task` (full field set — title, body, due, start,
  reminder, importance, status, categories, recurrence, isReminderOn),
  `update_task` (PATCH, all optional, `if_match` for optimistic concurrency),
  `delete_task`, `move_task` (non-atomic create-in-destination + delete-from-source;
  sub-resources not copied — warning field in response).
- List mutation tools: `create_list`, `update_list`, `delete_list`. Each calls
  `invalidateLists()`; `delete_list` additionally calls `invalidateList(listId)`
  so the per-list KV row is cleared immediately.
- Checklist item tools: `list_checklist_items`, `create_checklist_item`,
  `update_checklist_item`, `delete_checklist_item`.
- Linked resource tools: `list_linked_resources`, `get_linked_resource`,
  `create_linked_resource`, `update_linked_resource`, `delete_linked_resource`.
  `update_linked_resource` closes the n8n stub gap (n8n's built-in To Do node
  shipped `updateFields: []` — no fields were actually patchable).
- Attachment tools: `list_attachments`, `get_attachment`, `create_attachment`
  (inline upload, ≤ 3072 KiB raw — empirically confirmed cap from Phase 0.5b),
  `delete_attachment`. Upload-session support (files > 3072 KiB) deferred; the
  `create_attachment` error message guides callers and the deferral is documented
  in README §Design decisions to revisit.
- `config:link_rules` infrastructure — `LinkRulesConfig` Zod schema
  (`src/config/schemas.ts`), KV loader, `get_link_rules` and `set_link_rules`
  admin tools. Malformed regex rejected at write time with the offending pattern
  in the error response.
- Link-rules engine (`src/config/link-rules-engine.ts`) — loads config, runs
  each rule's regex against task title (and optionally body), substitutes capture
  groups into URL + display-name templates, deduplicates by URL against existing
  linked resources, caps results by `max_links_per_task`. Regex DoS budget: 8 KB
  body cap + 50 ms total wall budget.
- `create_task` and `update_task` run link rules post-write; `update_task`
  triggers only when `title` or `body` changed. `update_task` re-fetches with
  `$expand=linkedResources` before applying rules so `existingUrls` is seeded
  and duplicates are not created on repeat updates.
- `extract_links({ list_id, task_id, dry_run? })` — standalone backfill tool.
  `dry_run: true` returns matches without writing. Deduplicates against existing
  linked resources on the task.
- `config:attachments` infrastructure — `AttachmentConfig` Zod schema, KV
  loader, `get_attachment_config` and `set_attachment_config` admin tools.
  `max_inline_bytes` controls the inline upload cap enforced by `create_attachment`.
- Cache invalidation on all Phase 3 mutations: task mutations call
  `invalidateList(listId)`; list mutations call `invalidateLists()` (and
  `delete_list` also calls `invalidateList`).

### Fixed — Phase 3

- `update_task`: PATCH response does not include `linkedResources`, so a
  re-fetch with `$expand=linkedResources` is performed before `applyLinkRules`;
  without this, `existingUrls` was always empty and re-running link rules on an
  already-linked task would create duplicates.
- `delete_list`: now calls both `invalidateLists()` and `invalidateList(listId)`;
  previously only `invalidateLists()` was called, leaving a stale
  `tasks:{listId}` row in KV until the next natural expiry.
- `create_attachment`: strips whitespace from the base64 string before
  estimating decoded byte size; MIME-formatted payloads include newlines every
  76 characters, inflating the estimate and triggering false-positive
  `attachment_too_large` rejections.

### Notes — Phase 3 smoke (live Worker, 2026-05-24)

- Full write-surface smoke run against the deployed Worker. All 14 steps passed
  clean — no `graph_429_retry`, `graph_401_refresh`, or `tool_unexpected` events.
- `update_task` — confirmed title, body, due, importance, and status all updated
  in a single PATCH call (the n8n-impossible case).
- `update_linked_resource` — confirmed displayName and webUrl patched on an
  existing resource (the other n8n-impossible case).
- `list_lists` cache: second call within 15-minute TTL returned `source: cache`;
  after `delete_list`, next call returned `source: graph_200` (invalidation
  confirmed).
- Link-rules end-to-end confirmed post-smoke: loaded a test rule
  (`T(\d{8})\.(\d{4})` pattern; `$1`/`$2` capture the digit groups after the
  leading `T`), ran `create_task` with a matching title — `link_rules.created`
  contained one entry. Re-ran `update_task` with the same match in the title —
  `link_rules.created` was empty (dedup fired; the `$expand=linkedResources`
  re-fetch correctly seeded `existingUrls`). Test rule and list cleaned up;
  `rule_count` restored to 0.
- Attachment round-trip: `create_attachment` → `get_attachment` returned
  identical `contentBytes`; `delete_attachment` succeeded.
- `move_task` correctly reported `sub_resources_not_copied` for the 1 checklist
  item and 1 linked resource that existed on the source task.

### Notes — Phase 2 step 9 empirical findings (Inspector smoke against the live Worker)
- `/me/todo/lists` does NOT emit a collection-level ETag on either the page
  envelope or the response header. The original `CachedLists.etag` field
  and its `If-None-Match` plumbing were dropped as no-ops. Per-resource
  ETags continue to ride inline on each `TodoTaskList` via `@odata.etag`
  passthrough and remain usable for any future per-list conditional GETs.
- `$expand=checklistItems,linkedResources,attachments` works on `/v1.0`
  for `get_task` — no fallback to parallel `mapPool` sub-collection fetches
  was needed.
- No `graph_429_retry`, `graph_401_refresh`, or `tool_unexpected` events
  fired across the full smoke walkthrough. Cache-hit `list_lists` calls
  recorded `durationMs: 6` (no Graph round-trip); Graph-touching calls
  150–1000 ms depending on payload size.
