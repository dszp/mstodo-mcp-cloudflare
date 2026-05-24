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

## 4. Email-to-task webhook ingress

Migrate the existing email-to-task flow off n8n: a webhook (or Cloudflare Email
Routing handler) that parses an inbound message and creates a task via the same
`create_task` logic (link rules apply automatically). Lets the n8n instance be
retired entirely once §3(b) also lands.

## 5. Multi-user mode

Replace the hardcoded `owner` props and the singleton `idFromName("owner")` DO
with per-user, KV-scoped tokens and per-user DO keying (the `OWNER_DO_NAME` seam
in `src/cache/sql.ts` is the deliberate extension point). Significant rework —
identity wipe, token storage, and the owner gate all become per-user. Only worth
doing if sharing a single running instance across people becomes a real need.

## 6. Search ranking tuning

Tune the FTS5 relevance: custom BM25 column weights (title over body) and an
optional recency boost so recently-modified matches rank higher. Low effort,
incremental; gated on real-usage feedback about result ordering.

## 7. R2 attachment mirror

Optionally mirror file attachments into R2 for offline-resilient reads and to
sidestep Graph's inline-content size limits on the read path. Additive; the
attachment tools already centralize attachment I/O.

## 8. Web-based attachment upload (`/upload` endpoint)

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
