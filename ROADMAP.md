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
