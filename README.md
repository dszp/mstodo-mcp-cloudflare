# mstodo-mcp

[![CI](https://github.com/dszp/mstodo-mcp-cloudflare/actions/workflows/ci.yml/badge.svg)](https://github.com/dszp/mstodo-mcp-cloudflare/actions/workflows/ci.yml)

**Use your Microsoft To Do tasks from Claude (or any MCP client), in plain
language.** This is a personal, self-hosted server you run on your own Cloudflare
Worker that connects Claude.ai to your Microsoft To Do account — so you can ask
Claude to find, create, update, complete, search, and organize tasks across all
your lists without leaving the chat. It keeps a fast local mirror of your lists and
tasks, so searching and querying across every list is quick and doesn't hammer
Microsoft on each request.

It's **single-user by design**: one deployment serves exactly one Microsoft
account (everyone else is rejected by an owner-identity gate), so it's meant for
running your own private instance — not a shared/multi-tenant service.

## Contents

- [Requirements](#requirements)
- [Tools](#tools)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Reset](#reset)
- [Identity-change auto-wipe](#identity-change-auto-wipe-built-in)
- [Design decisions to revisit](#design-decisions-to-revisit)
- [Author](#author)
- [Deployment guide →](./DEPLOYMENT.md)
- [Changelog →](./CHANGELOG.md)

## Requirements

- A **Microsoft 365 (M365)** or personal Microsoft account that uses Microsoft To Do.
- A **Cloudflare account** — the free plan works for small accounts; **Workers Paid**
  is recommended once you have **thousands of tasks** (see the plan note in the
  deployment guide).
- A **Microsoft Entra app registration** — free, created once (walkthrough in the
  [deployment guide](./DEPLOYMENT.md#microsoft-entra-app-registration)).
- **Node 18+** and Cloudflare's **Wrangler** CLI, to deploy.
- **Claude.ai** (or another MCP client) to connect to the deployed server.

➡️ **Setup & deployment:** see **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full
step-by-step guide (including the Microsoft Entra app registration), custom-domain
setup, and troubleshooting. The [Configuration](#configuration) reference is below.

## Tools

The server exposes a Microsoft To Do tool surface over MCP. Highlights:

- **Lists & tasks (CRUD)** — `list_lists`, `get_list`, `create_list`, `update_list`,
  `delete_list`; `list_tasks`, `get_task`, `create_task`, `update_task`,
  `delete_task`, `move_task`.
- **Sub-resources** — checklist items and linked resources
  (create/list/get/update/delete each); attachments (`list_attachments`,
  `get_attachment`, `delete_attachment`).
- **Attachment upload** — `create_upload_link` mints a short-lived, single-use
  web link the user opens in a browser to attach file(s) to a specific task. The
  bytes go browser → Worker → Microsoft (≤ 25 MB each, inline or chunked
  upload-session) and never pass through the model. See
  [Web upload](#web-upload--upload) below.
- **Cross-list query & search** (answered from the local `TodoIndex` mirror):
  - `query_tasks` — filter by lists, status, date ranges, importance, has-checklist;
    `types`/`exclude_types` (include/exclude by list classification); a `completed`
    convenience (mutually exclusive with `status`); paginated.
  - `search_tasks` — full-text search over task titles/bodies using **FTS5**
    (SQLite's built-in full-text search engine); same `lists`/`status`/`types`/
    `exclude_types`/`completed` filters. `exclude_types:["excluded"]` drops noise
    (e.g. flagged-email lists) from results without deleting anything.
  - `find_task_list`, `get_pending_across_lists`, `get_recently_completed`.
- **Config** — `get_list_config`/`set_list_config` (classification patterns,
  `no_sync`, `sync_flagged_emails`), `set_list_alias`, `get_link_rules`/
  `set_link_rules`, `get_attachment_config`/`set_attachment_config`, `extract_links`.
- **Ops** — `whoami`, `sync_status`, `resync`.

## How it works

Claude.ai connects to the Worker over remote-MCP; the Worker brokers requests to the
Microsoft Graph API (OAuth authorization-code flow with PKCE + a client secret). A
singleton **`TodoIndex` Durable Object** (Cloudflare's stateful, strongly-consistent
compute primitive) keeps a **delta-synced mirror** of your lists and tasks in its
embedded SQLite database, alongside an **FTS5** full-text index (FTS5 is SQLite's
built-in full-text search engine). Cross-list `query_tasks`, `search_tasks`, and
aggregation tools read from this local mirror rather than re-walking Graph on every
call; a `*/15` cron keeps it synced and an owner-identity gate keeps it private.

Small, slowly-changing state — your OAuth tokens, the owner-identity record, and the
config blobs below — lives in Cloudflare **KV (a key-value store)**. The large,
frequently-queried task corpus lives in the Durable Object's SQLite, not KV.

## Configuration

Three optional config blobs live in KV under the `TODO_CACHE` binding. Ready-to-edit
examples (with the exact `wrangler kv key put` commands) are in `config-examples/`.

### `config:lists` — classification, aliases, sync control
- **`patterns`** — ordered regex rules matched against list display names (emoji
  stripped, case-insensitive by default); first match wins →
  `todo` | `reference` | `excluded`. Unmatched lists are `unclassified`.
  Classification powers `list_lists` filtering and the `types`/`exclude_types`
  params on `query_tasks`/`search_tasks`. `excluded` keeps a list out of
  type-filtered tools but does **not** stop it syncing — use `no_sync` for that.
- **`aliases`** — short handle → Graph list ID, usable anywhere a list is accepted.
  Cleared automatically on a Microsoft identity switch (IDs are per-account).
- **`no_sync`** — lists excluded from delta sync, matched by `wellknownListName` or
  Graph list ID. They stay listed and on-demand-readable but aren't indexed. Settable
  conversationally via `set_list_config`; the sync loop self-heal-purges a list's rows
  if you add it later.
- **`sync_flagged_emails`** — the `flaggedEmails` well-known list is **skipped by
  default** (it's often huge and not a real task list); set `true` to index it. This
  built-in skip is independent of `no_sync`.

### `config:link_rules` — auto-link tasks
Regex → linked-resource rules applied to task titles/bodies. See `config-examples/link-rules.json`.

### `config:attachments` — inline upload cap
`max_inline_bytes` (hard ceiling 3072 KiB, the confirmed Graph limit). For web uploads this is
the cutover point: files at or below it are attached inline, larger ones (up to 25 MB) via a
chunked Graph upload-session. See `config-examples/attachments.json`.

### Web upload (`/upload`)
File bytes can't practically travel through an MCP tool call (the model's per-call argument
budget is a few KB). Instead, `create_upload_link` mints a short-lived (default 15 min, max 30),
**single-use** link scoped to one specific task; the user opens it in a browser and the bytes go
straight from the browser to the Worker and on to Microsoft Graph — never through the model.
Provide a `filename` for a single-file link, or omit it for a batch link (up to `max_files`,
1–10, default 5). Identical files already attached to the task are detected by content hash and
skipped as duplicates.

The link is a **capability token**: an unguessable random id (32 bytes from the CSPRNG). The
destination scope (list/task ids, filename, file count) is stored server-side in `OAUTH_KV` under
that id with a TTL; the id in the link reveals nothing. Holding the id authorizes one upload to
exactly the scoped task — verified by a KV lookup, expired by the TTL, consumed (deleted) on use.
There is **no signing key or shared secret** to configure: the id *is* the nonce.

To enable it, set **`SERVICE_BASE_URL`** (var, in `wrangler.jsonc`) — the public origin of this
Worker (your `workers.dev` URL or custom domain), used to build the link. With it unset (or left
at the placeholder), `create_upload_link` returns `upload_disabled`.

## Reset

Three scopes, smallest to largest. Run from the project root; replace `--remote` with `--local` if you want to operate on the miniflare local KV store used by `wrangler dev`.

### 1. Soft reset between test iterations

Most common: re-trigger the Microsoft OAuth flow without nuking infrastructure. Identity-change auto-wipe (built into `/auth/microsoft/callback`) will automatically clear the per-identity cache the next time you authorize as a different Microsoft 365 (M365) account, but you can also wipe manually.

```bash
# Wipe the stored Microsoft refresh token. Forces the next /authorize to
# re-run the full code-exchange flow.
npx wrangler kv key delete --binding=TODO_CACHE --remote tokens:owner

# Also wipe the stored identity record if you want to "forget" which
# account was last seen (this disables the identity-change wipe trigger
# the next time you sign in — useful when you want to test the wipe).
npx wrangler kv key delete --binding=TODO_CACHE --remote identity:owner

# Wipe all Claude.ai-side OAuth grants (DCR sessions) — forces every
# previously-paired Claude.ai client to re-add this MCP from scratch:
npx wrangler kv key list --binding=OAUTH_KV --remote \
  | jq -r '.[].name' \
  | xargs -I {} npx wrangler kv key delete --binding=OAUTH_KV --remote {}
```

If you also want Microsoft to re-prompt for consent (rather than silently re-issuing tokens because consent is already on file), either revoke the app from the user's account permissions page on the M365 side, or — once we expose the option — pass `&prompt=consent` to `/authorize`.

### 2. Rotate credentials

Edit `.dev.vars` with the new values, then push them all to Cloudflare in one go:

```bash
bash scripts/push-secrets.sh
```

The script reads each name from `.dev.vars` and pipes the value over stdin to `wrangler secret put`, so values never appear in argv, environment, terminal scrollback, or AI transcripts. Verify with `npx wrangler secret list`.

To push a single secret manually instead:

```bash
npx wrangler secret put MS_CLIENT_SECRET     # prompts for value
```

The **old client secret remains valid** until you also delete it in the Azure portal — `wrangler secret put` only updates the Worker side.

After rotating, do a soft reset (above) so the next `/authorize` uses the new identity.

### 3. Full clean slate

For pre-launch publishability checks, or to recover from corrupted state:

```bash
npx wrangler delete --name=mstodo-mcp                       # nukes Worker + all DO state
npx wrangler kv namespace delete --binding=OAUTH_KV
npx wrangler kv namespace delete --binding=TODO_CACHE
# Then re-create namespaces + update wrangler.jsonc + redeploy (see DEPLOYMENT.md).
```

This is the "I want this account to look like a fresh fork" path. Note that **`wrangler delete` is destructive and not recoverable**.

## Identity-change auto-wipe (built in)

When `/auth/microsoft/callback` completes against a different `me.id` than the previously stored `identity:owner.id`, the Worker automatically wipes per-identity state before storing the new tokens. This prevents silently mixing tasks from two M365 accounts.

What the auto-wipe clears, in order (fail-closed — the Durable Object reset runs
first, so if it throws nothing else has happened and `/authorize` aborts before
storing the new tokens, never leaving a half-wiped mix):

1. **`TodoIndex` DO reset** — drops all indexed tasks, the list roster, and every
   delta `sync_state` cursor (the task corpus lives in the DO's SQLite, not KV).
2. **`tokens:owner`** then **`identity:owner`** in `TODO_CACHE` (identity marker last,
   so a failure mid-wipe re-triggers the wipe on the next `/authorize` rather than
   silently skipping it).
3. **`config:lists.aliases`** — best-effort, since aliases are per-account Graph IDs
   that would resolve to dead lists after a switch. Classification `patterns`,
   `no_sync`, `sync_flagged_emails`, `config:link_rules`, and `config:attachments` are
   **preserved** (account-independent intent).

`OAUTH_KV` grants are **not** touched by the auto-wipe — your Claude.ai pairing keeps working across an MS-account swap. If you want the Claude.ai client to re-authenticate from scratch too, run the OAUTH_KV wipe in the soft-reset block above.

When the auto-wipe fires, a structured log line is emitted:

```json
{"level":"warn","event":"identity_change_wipe","prev_id":"…","prev_mail":"…","new_id":"…","new_mail":"…","hint":"…"}
```

You can `wrangler tail` to watch for it during testing.

## Design decisions to revisit

Captured here so future maintainers can reconsider when usage patterns suggest a different tradeoff.

### `list_tasks` pagination — live per-page fetch, no snapshot cache

The Phase 2 `list_tasks` tool paginates directly against Graph (`$top` + `@odata.nextLink`). The `next_cursor` returned to callers is the opaque Graph nextLink URL; subsequent calls GET that URL through the standard `GraphClient` token/refresh path. **`tasks:{listId}` is NOT written by this tool** — Phase 5 delta sync is the sole writer of that cache key.

This is a documented deviation from the Phase 2 plan's "Cache snapshot to `tasks:{listId}` with ETag" instruction. **Option A** (chosen) vs **Option B** (fetch-all-pages on first call, cache snapshot, slice into pages from cache thereafter):

| Axis | A (live, chosen) | B (snapshot) |
|---|---|---|
| Graph calls | 1 per user page (linear with navigation depth) | 1× full-collection fetch on first call; cached reads thereafter |
| First-page latency | Best — single GET | Worst — must follow all nextLinks before responding |
| Subsequent-page latency | Same as first | Sub-ms (KV read) |
| Consistency across pages | Standard REST pagination tearing if tasks change mid-walk | Snapshot-consistent across pages, but the snapshot ages |
| Cursor shape | Opaque Graph URL, pass-through (prefix-validated against `graph.microsoft.com/v1.0/me/todo/lists/`) | Our own opaque token (offset or similar) |
| Code in step 7 | ~30 lines | ~80–100 lines |
| Phase 5 interaction | Phase 5 delta is sole writer of `tasks:{listId}`; one owner of cache shape | Phase 5 inherits step-7 cache writes; shape-migration concern if delta needs a different layout |
| Empirical observability | Each call surfaces real Graph pagination behavior | First call exercises pagination; later calls read cache |

**Revisit Option B if** `wrangler tail` later shows the LLM repeatedly paginating deep through large lists within short windows — the up-front fetch + cache reads would save Graph quota end-to-end at the cost of first-page latency. As of Phase 2, typical To Do usage is bursty and shallow; live pagination is cheaper overall and lets us defer the cache-shape commitment to Phase 5 where it's load-bearing.

### Attachment upload — web `/upload`, not an MCP tool call

**File bytes can't practically travel through an MCP tool call:** Claude's per-call output/token
budget caps tool arguments at a few KB, so all but trivial uploads fail before Graph is even
reached (confirmed while building the sibling `obsidian-mcp-cloudflare` project). The inline
3072 KiB Graph cap was never the binding constraint — the MCP transport was.

The original `create_attachment` tool (inline base64 in the tool call) was therefore **removed**
and replaced by the web-upload flow: `create_upload_link` + the public `/upload` endpoint (see
[Web upload](#web-upload--upload)). Bytes go browser → Worker → Graph, attached inline for
≤ 3072 KiB and via a chunked upload-session for larger files up to 25 MB. Links are capability
tokens — an unguessable random id whose task scope lives in `OAUTH_KV` under a TTL — task-scoped,
single-use, and never generic (every link targets one specific task). No signing key or shared
secret is involved. The Worker forwards bytes synchronously during the POST, so no R2 bucket or
temporary blob storage is needed. Ported from `obsidian-mcp-cloudflare` (its `src/upload/*`),
adapted to the To Do attachment APIs and simplified to a secret-less capability token.

## Author

Built by [David Szpunar](https://david.szpunar.com). Licensed under the [MIT License](./LICENSE). Release history in the [changelog](./CHANGELOG.md).
