# Roadmap

Capabilities the project is **designed for** but that are not in the initial
(v0.1.0) scope. The v1 architecture deliberately does not preclude any of them —
each is landed when it becomes useful, not on a schedule, so there are no dates
here. Entries are roughly ordered by likelihood of being built next.

The single most important design property these build on: **every tool's logic
is a thin handler over the `TodoIndex` Durable Object (queries/search/aggregations)
and the `GraphClient` (mutations).** New surfaces (HTTP, cron) reuse those, so
they are additive rather than rewrites.

---

## 1. HTTP API surface for non-MCP callers (including n8n) — *front-runner*

Expose the existing tool handlers under `/api/v1/...` for callers that speak HTTP
rather than MCP. **This is the most likely next thing to build.** The leading
intent: let the existing n8n workflows call *this* Worker's API instead of talking
to Microsoft Graph directly, while keeping the scheduling/reporting logic in n8n
(see §3 for the alternative of moving reporting onto Workers cron — that decision
is deferred until the API exists and the trade-off is concrete).

**Why it's cheap:** every tool's logic already lives behind the MCP layer in
`src/mcp/agent.ts` as a handler over the DO + `GraphClient`. An HTTP layer imports
the same logic and dispatches via routes — zero refactor in the tool code.

**Sketch** (when added):

```
src/
  http/
    router.ts       # Hono or raw fetch; routes → shared tool logic
    auth.ts         # validates either a Cf-Access service token OR a bearer token
    schemas.ts      # request/response Zod schemas (mostly re-exports from tools)
```

**URL shape** (one route per tool):

```
POST   /api/v1/tasks/query                    → query_tasks
GET    /api/v1/tasks/search?q=...              → search_tasks
POST   /api/v1/tasks                           → create_task
PATCH  /api/v1/tasks/{task_id}                 → update_task
DELETE /api/v1/tasks/{task_id}                 → delete_task
POST   /api/v1/tasks/{task_id}/links/extract   → extract_links
GET    /api/v1/lists?type=todo                 → list_lists
GET    /api/v1/pending?type=todo               → get_pending_across_lists
GET    /api/v1/recently-completed?days=7       → get_recently_completed
GET    /api/v1/sync/status                     → sync_status
POST   /api/v1/sync/resync                     → resync
…one route per remaining tool
```

**Auth (both supported, selected by which secret is present):**

1. **Cloudflare Access service token** — put the Worker (or just the `/api/*`
   routes) behind CF Access; Access validates `CF-Access-Client-Id` +
   `CF-Access-Client-Secret` at the edge before the Worker runs. Strongest, free
   on Cloudflare, and the preferred path for n8n callers.
2. **Bearer token** — the Worker reads `Authorization: Bearer <token>` and
   compares it **constant-time** against an `HTTP_API_TOKEN` secret. Simpler;
   sufficient for the single-owner trust boundary and handy for local n8n dev
   without an Access setup.

**n8n integration paths:**

- **HTTP Request node** — configure URL + auth header; no custom node needed.
  Usable the day the API ships.
- **Custom n8n community node** — see §2.

**Effort:** ~1.5 days for the HTTP surface itself (router + auth + per-tool route
registration), assuming the tool logic is already clean.

## 2. Custom n8n community node

A community node package wrapping the §1 HTTP API with typed credentials
(Cf-Access service token + Worker base URL) and per-operation method/path
mappings. A declarative-style node is likely sufficient.

**Depends on:** §1 landing first. **Effort:** ~3–5 days, separate from §1.
(The `n8n-node-builder` skill encodes the official build/lint/publish workflow.)

## 3. Scheduled completed-task reports

The recurring "what got done" email report. Two viable homes — **decision
deferred** until the §1 API exists:

- **(a) Keep it in n8n, driven by the §1 API.** n8n's scheduler calls
  `GET /api/v1/recently-completed` and renders/sends the email as it does today.
  Smallest change; pairs naturally with §1 and the front-runner intent of keeping
  scheduling in n8n.
- **(b) Port it onto Workers cron** (the original "Phase 7"). A `scheduled()`
  handler queries `get_recently_completed` from the DO index, renders the HTML
  (porting the n8n Code-node email template), and POSTs to the mail provider
  (e.g. Postmark). Schedule/config lives in KV; same email template as today.
  Retires the last n8n dependency. **Effort:** ~2–3 days when revisited.

## 4. Graph change-notification subscriptions to augment delta polling (toggleable)

> **Status: SHIPPED on `feat/task-subscriptions` 2026-05-29 (gate `ENABLE_TASK_SUBSCRIPTIONS`, default ON).**
> `src/subscriptions/{gate,manager,webhook-handler}.ts` + a `subscriptions` SQLite table (migration v2)
> + `TodoIndex.onChangeNotification`/`reconcileSubscriptions`/`renewSubscriptions`; `POST /webhook` wired
> in `index.ts` after `/download`. Reconcile + renew run in `runSyncCycle`'s calm-cycle block,
> **budgeted** by `MAX_SUBSCRIPTION_OPS_PER_CYCLE`. Verified against current docs (2026-05-29):
> `todoTask` notifications are **basic-only** (not on the rich/resource-data list) and **global-cloud-only**,
> max lifetime **4,230 min**, webhook must ack within **3 s**. **§4a Phase 2 landed here too:** a notification
> triggers a *targeted* single-task Substrate `getTask` to refresh just the changed task's My Day fields
> (mark-scan-due fallback for a not-yet-cached task; periodic budgeted scan retained as backstop) — a
> full-list scan-on-notification remains a future option if per-task proves insufficient. The notification
> path is strictly read-only toward Microsoft, so it cannot emit a notification (no feedback loop).
> **OPEN, confirm after deploy:** does moving a task *within* My Day order (CommittedOrder-only change) bump
> Graph's `lastModifiedDateTime` and thus fire the webhook? Only CommittedDay was verified to (§4a). If it
> doesn't, within-My-Day reordering is caught only by the periodic scan regardless.

Drive *when* delta sync runs from Microsoft Graph push notifications instead of
only the timer, collapsing typical update lag from "next cycle interval" to
Graph-to-webhook latency (sub-second) — i.e. near-instant updates like the native
To Do apps, while delta polling stays in place as the backstop. **Gated behind a
new `ENABLE_TASK_SUBSCRIPTIONS` preference.** It rides the existing delegated
`Tasks.ReadWrite` scope (see below) — **no additional permission or admin consent** —
so the gate is a user preference, not a permission wall. **Lean the default ON** once
`SERVICE_BASE_URL` is reachable: near-instant freshness at no extra consent cost. But
keep it a genuine toggle, for two distinct reasons a user might disable it: (1) it
stands up a public webhook receiver + renewal cron, so a deployment that doesn't want
that surface can stay timer-only (this is the argument for a conservative OFF default
if you weight attack surface over freshness); and (2) Graph subscriptions draw on a
**tenant-wide budget shared across every app in the tenant** — `todoTask` itself has no
documented per-resource cap (its row in Graph's supported-resources table lists no quota,
unlike `user`/`group` at 100 per app+tenant / 1,000 per tenant, or the Teams resources),
but a tenant already spending its subscription budget on other integrations must be able to
opt our subscription creation out, independent of everything else the server does. (If any
limit is hit, Graph returns `403` and `#createSubscriptionFor` logs `subscription_create_failed`
and falls back to timer-only for that list.)

**This is a documented public Graph capability, not first-party-only.** Graph
exposes change-notification subscriptions on
`/me/todo/lists/{todoTaskListId}/tasks` (one subscription per list, covering all
tasks in that list). Delegated `Tasks.ReadWrite` is the least-privileged
permission and **application permissions are "Not supported"** for this resource —
so it rides the existing delegated auth funneled through `TodoIndex`, not a
daemon-style app token. The undocumented Substrate plane (which gives us lossless
`move_task` and My Day CRUD) is unrelated and unlocks nothing subscription-flavored
beyond what documented Graph already exposes.

**Architectural fit — subscriptions drive delta, they don't replace it.**
Notification arrives → look up the list ID → invalidate that list's cache → trigger
the existing per-list delta sync. Every property already built is preserved:
stale-first prioritization, delta tokens, error tracking, the fair oldest-first
rotation. The `alarm()`/`runSyncCycle()` scheduler stays as the backstop, just at a
**much longer `DELTA_SYNC_INTERVAL_MIN`** since most syncs become event-triggered
rather than timer-driven.

**Pieces to add:**

```
src/
  subscriptions/
    webhook-handler.ts   # public POST /webhook: validation-token echo on create,
                         #   clientState check, notification → enqueue per-list delta
    manager.ts           # create/renew/delete subscriptions; map subscriptionId↔listId
```

- **`POST /webhook` handler**, wired in `index.ts` alongside `handleUpload` /
  the `/download` handler (public, pre-OAuth). On subscription creation Graph sends
  a `validationToken` query param that must be echoed back as `text/plain` within
  10s; on a real notification it validates `clientState` (and verifies the JWT if we
  ever opt into rich/with-resource-data notifications), resolves the list ID, and
  enqueues a delta-sync run on the `TodoIndex` singleton.
- **Renewal cron.** Subscription lifetime maxes at **4,230 minutes (~2.94 days)** for
  `todoTask`, so a renewal must run well under that — fold it into the existing
  `*/15` cron (or a dedicated daily one) calling `manager.ts`.
- **Subscribe/unsubscribe hook in the lists-delta sync.** When the `$delta` on
  `/me/todo/lists` reports a list created/deleted, create/tear down its subscription
  so coverage tracks the live list roster (~38 lists today — comfortably inside Graph's
  100-per-app+tenant / 1,000-per-tenant caps for this deployment, but those caps are
  **shared across every app in the tenant**, which is why `ENABLE_TASK_SUBSCRIPTIONS`
  must let a user disable our subscription creation rather than assume the budget is ours).

**Delta polling stays mandatory — there is no missed-notification safety net for
`todoTask`.** Graph lifecycle/`missed` events currently cover only Outlook message,
event, and personal contact. If Graph silently drops a notification we are *not*
told, so the timer-driven cycle must remain the backstop (just slower); this is why
the feature augments rather than replaces polling.

**Constraints to price in (all fine for the current single-owner M365 tenant):**

- **Global cloud only** — not available in national clouds (matters only if a
  GCC/GCC-High tenant is ever onboarded).
- **No personal MSA (outlook.com) and no Azure AD B2C** — the supported case is the
  M365 work account, which the `OWNER_EMAIL` gate already enforces.

**One thing to verify before building:** whether Graph delivers *basic-only* or
supports *rich (with-resource-data)* notifications for `todoTask`. Current read of
the docs: `todoTask` isn't on the rich-notifications supported-resources list, so
expect basic-only — meaning after the webhook fires we still GET the changed task by
ID (one extra round-trip, but architecturally identical since we re-delta the list
anyway). Confirm against the current rich-notifications page before committing.

**Effort:** ~2–3 days — webhook handler + validation/clientState dance (portable in
spirit from the `/upload` + `/download` capability handlers), the subscription
manager, the renewal cron, and the subscribe-on-list-create hook; plus the
`ENABLE_TASK_SUBSCRIPTIONS` gate and `SERVICE_BASE_URL`-derived webhook
`notificationUrl`.

### 4a. SQLite cache of the Substrate-only fields (CommittedDay / CommittedOrder / OrderDateTime / PostponedDay) — ✅ Phase 1 DONE

> **Status: Phase 1 shipped.** Four new `tasks` columns (`committed_day`, `committed_order`,
> `order_datetime`, `postponed_day`) populated by a background Substrate scan inside
> `runSyncCycle` plus write-through on `add_to_my_day` / `remove_from_my_day`.
> `list_my_day_tasks` is cache-backed — zero live Substrate round-trips on the read path — and
> now honors `PostponedDay` faithfully. The scan is **budgeted**: each list is rescanned at most
> once per `MY_DAY_SCAN_EVERY_N_CYCLES` window, but only `MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE`
> lists are scanned per cycle (oldest-first rotation, calm cycles only), so the scan's Substrate
> requests stay well under the Workers free-tier subrequest ceiling on any roster size. Schema
> versioning uses a `schema_meta` table (Workers DO SQLite blocks `PRAGMA user_version`).
> **Still remaining (Phase 2):** drive scan invalidation from §4 change notifications so the
> cache tightens toward near-live without polling Substrate at all.

**Verify before building Phase 2 — does a My-Day-only change even reach Graph? ✅ ANSWERED 2026-05-28: YES (first branch).** Phase 2 assumes
a §4 task notification fires when My Day membership changes in the app. But My Day lives in
`CommittedDay`, a Substrate/Exchange field Graph cannot see, set by a Substrate PATCH. Whether
that PATCH bumps the task's *Graph-visible* change tracking (`lastModifiedDateTime` / the delta
token watermark) is a backend property of Microsoft's, not derivable from our code — and it
forks the design:

- **Bumps it** → the task enters the list's `$delta` feed (with no `CommittedDay` field) and a
  subscription fires. After the (basic-only) notification we re-delta, see the task changed, and
  can trigger a targeted Substrate GET of just that task to refresh its My Day fields. Phase 2 can
  drive My Day freshness off subscriptions.
- **Doesn't bump it** → My-Day-only app changes are invisible to Graph's change tracking entirely.
  Subscriptions still cover real edits (title/due/status/completion), but pure drag-to-My-Day in
  the app is caught *only* by the periodic background scan — which then stays mandatory for My Day
  no matter how good subscriptions get. (Self-induced changes are unaffected either way:
  `add_to_my_day` already write-throughs.)

**The test (runnable now with existing tools, no instrumentation):** (1) pick a task not on My
Day, `get_task` it live and record `lastModifiedDateTime` = T0; (2) move just that task to My Day
in the app, no other edits; (3) `get_task` live again. If `lastModifiedDateTime` is unchanged →
*conclusive* second branch (Graph never recorded the change). If it advanced to T1 → Graph saw
it; confirm it actually propagates **incrementally** (not just in a baseline) by letting the next
normal sync cycle run — **do not `resync`, which re-baselines and would include the task
regardless** — then `list_tasks` the list and check the cached `lastModifiedDateTime`. The cache's
`modified_at` is written only by the delta path, so if it advances T0→T1 off an incremental cycle,
the task came through `$delta` and a subscription would have fired. A raw-delta-page dump or a
per-task delta log line would only be needed to *watch* it live; the cache check settles the
question without it.

**Result (run 2026-05-28, subject "Attachment Test" on the default Tasks list).** First branch
confirmed. T0 `lastModifiedDateTime` = `2026-05-27T07:03:02.412Z`; after a Substrate-plane
`CommittedDay` set (via `add_to_my_day` — plane-identical to the app's gesture), live `get_task`
read T1 = `2026-05-28T23:42:14.536Z` (Graph and Substrate agreed to the microsecond). The next
normal incremental cycle (Tasks list synced ~23:47 UTC, ~5 min after the change, no `resync`, no
baseline, `row_count` steady) advanced the *cached* `lastModifiedDateTime` to T1 — and `modified_at`
is written only by the delta path, so the task provably rode the incremental `$delta` feed.
**Conclusion: a My-Day-only change reaches Graph's incremental delta, so a §4 subscription fires on
it.** Phase 2 can drive My Day freshness off subscriptions; the periodic Substrate scan can relax
to a slow safety-net rather than the primary freshness path. The basic-only caveat stands — the
notification triggers a re-delta, and a Substrate GET still reads the new `CommittedDay` (delta
carries the changed task but not the Substrate-only field).

**Free-tier safety vs. freshness (the per-cycle budget knob).** `MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE`
(default 6) bounds the scan's per-request cost: a large roster is covered over ⌈roster ÷ cap⌉ calm
cycles rather than one burst, so free-tier deployments never approach the 50-subrequest ceiling.
Workers Paid deployments can raise the cap (up to the roster size) to refresh the whole roster
every cycle. **Other limitations:** `listFolderTasks` doesn't paginate (folders larger than
Substrate's default page size only refresh their first page from the scan; write-through still
covers user-touched tasks).

## 5. Email-to-task webhook ingress

Migrate the existing email-to-task flow off n8n: a webhook (or Cloudflare Email
Routing handler) that parses an inbound message and creates a task via the same
`create_task` logic (link rules apply automatically). Lets the n8n instance be
retired entirely once §3(b) also lands.

## 6. Search ranking tuning

Tune the FTS5 relevance: custom BM25 column weights (title over body) and an
optional recency boost so recently-modified matches rank higher. Low effort,
incremental; gated on real-usage feedback about result ordering.

## 7. R2 attachment mirror

Optionally mirror file attachments into R2 for offline-resilient reads and to
sidestep Graph's inline-content size limits on the read path. Additive; the
attachment tools already centralize attachment I/O.

## 8. Web-based attachment upload (`/upload` endpoint) — ✅ DONE

**Implemented.** `create_attachment` (inline base64) was removed and replaced by
`create_upload_link` + the public `/upload` endpoint. The tool mints a short-lived
(default 15 min, max 30), single-use link scoped to one specific task; the user opens
it in a browser and bytes go browser → Worker → Graph (inline for ≤ 3072 KiB, chunked
upload-session up to 25 MB), never through the model. Links support a single baked
filename or a batch of up to `max_files` (1–10, default 5); exact-duplicate files (by
content hash) already on the task are skipped. The link is a **capability token** — an
unguessable random id whose task scope is stored in `OAUTH_KV` under a TTL, verified by
lookup, single-use by delete; **no signing key / shared secret** (simplified from the
originally-planned HMAC design — see below — since single-use already requires KV state).
Bytes are forwarded synchronously (no R2 / no temp blob). Requires only the
`SERVICE_BASE_URL` var. Code: `src/upload/{tokens,sniff,graph-upload,handler,page}.ts`;
tests under `test/upload-*`.

Original design notes below (retained for context).

`create_attachment` takes file bytes as base64 in the tool call, but **a real
file can't practically be uploaded through an MCP tool call.** Claude's per-call
output/token budget caps tool arguments at a few KB, so anything beyond a trivial
file blows the budget and the call fails — almost all in-call attachment uploads
fail today. The Graph inline cap (≤ 3072 KiB) and the upload-session path for
larger files are *secondary*: the MCP transport is the real constraint, not Graph.
(Confirmed while building the sibling `obsidian-mcp-cloudflare` project.)

**Approach — repurpose the `obsidian-mcp-cloudflare` pattern.** Add a public
(non-OAuth) `/upload` endpoint plus a `create_upload_link` tool that mints a
short-lived (default ~15 min, max ~30), single-use web link the user taps. The
file bytes go **straight from the user's browser to the Worker — never through the
model.** The Worker then attaches them to the target task via Graph (inline for
≤ 3072 KiB; upload-session / chunked `PUT` for larger files, which only becomes
relevant once bytes arrive out-of-band).

Mechanics to port from `obsidian-mcp-cloudflare` (`src/upload/*`, the shared
public handler, the `create_upload_link` tool shape):

- **Signed token:** HMAC-signed with an `UPLOAD_TOKEN` secret, carrying a random
  `jti`, an `exp`, and the destination scope (list/task id, optional filename).
  The `jti` is written to KV with a matching TTL so each link is usable **at most
  once and only within its window**.
- **Upload page** + content-type sniffing from the leading bytes.
- The tool returns `{ upload_url, expires_at, … }`; Claude presents it as a
  tappable link and polls `list_attachments`/`get_attachment` afterward.

**Effort:** ~1–1.5 days, most of it portable from `obsidian-mcp-cloudflare`.
Supersedes inline `create_attachment` for anything but trivial payloads; the
inline path stays as a fast path for tiny files.

## 9. Cross-server attachment transfer (`mint_download_link` + server-side pull)

> **Status: To Do source side shipped.** `mint_download_link` + the public `/download`
> endpoint are implemented (capability token in `OAUTH_KV` under a `download:` prefix,
> ≤5-min single-use, burned on first reachable GET; gated by `ENABLE_DOWNLOAD_LINKS`,
> default on). **Still remaining:** the pull-side host allowlist on the *destination*
> (Obsidian's `upload_attachment_url`), and the reverse direction (`ingest_from_url` into
> To Do via the Graph upload-session path).

The inverse of §8's upload link: a **server-to-server signed-URL pull** so the AI
can move an attachment from one MCP server to another (e.g. an MS To Do task →
an Obsidian vault note) **without the bytes ever traversing the model's context**.
This is the no-context, large-file path that complements `get_attachment`'s inline
`image` block (good for small images, bad for multi-MB binaries).

**Flow — the AI stays the orchestrator; no MCP-to-MCP auth.** Two tool calls, no
shared credentials between servers beyond the capability URL itself:

1. `MS To Do: mint_download_link(list?, task_id, attachment_id)` → returns
   `{ download_url, filename, content_type, size, expires_at }`.
2. `Obsidian: upload_attachment_url(url, target_note, filename)` (already exists) —
   Obsidian fetches the URL **server-side** and stores it.
3. Bytes flow `mstdo.scriptek.com → obsv.scriptek.com` directly; the model only
   passes the opaque URL between the two calls.

For the reverse direction: a symmetric `Obsidian: mint_download_link` plus an
`MS To Do: ingest_from_url` server-pull that attaches via the Graph upload-session
path. The existing `create_upload_link` tools remain the human/browser-driven
version of the same pattern.

**Mechanics — reuse the §8 capability token, reversed.** A public `/download`
endpoint streams one attachment's bytes for a valid signed id; the scope in KV is
`{ list_id, task_id, attachment_id }` instead of an upload destination. The bytes
are fetched from Graph (`.../attachments/{id}/$value` or `contentBytes`) and
streamed to the caller. `mint_download_link` returns the URL plus the file
metadata it read at mint time.

**Hard requirements (must ship with it):**
- **TTL ≤ 5 minutes, single-use.** Burn the capability on first read so a URL that
  lands in conversation history self-destructs. (Same KV single-use mechanism as §8.)
- **URL allowlist on the *pull* side** — the single most important guardrail. The
  ingesting server (Obsidian's `upload_attachment_url`, or a future
  `ingest_from_url` here) must refuse to fetch from arbitrary hosts; maintain a
  small host allowlist (`mstdo.scriptek.com` ↔ `obsv.scriptek.com`). Without it, a
  prompt injection in any processed content could redirect bytes to an
  attacker-controlled URL.
- **Scope is one attachment**, read-only — not bearer access to anything else.
- **Size cap enforced at the pull side**, not trusted from the source's headers.
- **`filename` / `content_type` passed out-of-band** (from the mint tool's return),
  not derived from the download response headers.
- **Content-hash (SHA-256) dedup at the destination**, not filename — filename
  collisions are noisy (see §8 / Graph's dup-name behavior).
- **Idempotent writes** — fetch to temp, write atomically, return the final id; a
  mid-stream failure leaves nothing partial.
- **Audit log on both sides** — who minted, who fetched, when. AI-initiated
  cross-server transfers warrant a paper trail.

**Explicitly out of scope:** MCP-to-MCP authentication. The capability URL (scoped,
single-use, ≤5 min) is the only thing shared between servers; the two servers never
authenticate to each other. Keeps the auth surface minimal and the AI in control.

**Effort:** ~0.5–1 day on the To Do side (mint tool + `/download` endpoint, both
portable from the §8 capability/handler code); the destination `upload_attachment_url`
already exists on the Obsidian side and mainly needs the host allowlist hardened.

## 10. Multi-user mode

Replace the hardcoded `owner` props and the singleton `idFromName("owner")` DO
with per-user, KV-scoped tokens and per-user DO keying (the `OWNER_DO_NAME` seam
in `src/cache/sql.ts` is the deliberate extension point). Significant rework —
identity wipe, token storage, and the owner gate all become per-user. Only worth
doing if sharing a single running instance across people becomes a real need.
