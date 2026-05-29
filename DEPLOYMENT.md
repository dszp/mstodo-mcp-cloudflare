# Deployment guide

A step-by-step walkthrough for running your own `mstodo-mcp` instance, plus a
troubleshooting section. For the feature/config reference and the MCP tool list,
see [README.md](./README.md).

## Contents

- [Prerequisites](#prerequisites)
- [Microsoft Entra app registration](#microsoft-entra-app-registration)
- [Steps](#steps)
- [Optional: custom domain](#optional-custom-domain)
- [Keeping sync cost down](#keeping-sync-cost-down)
- [My Day support (optional)](#my-day-support-optional)
- [Troubleshooting](#troubleshooting)
- [Local development](#local-development)
- [Reset and teardown](#reset-and-teardown)

## Prerequisites

- **Node 18+** and **npm** (Wrangler 4 is pinned in `devDependencies`).
- A **Cloudflare account**, logged in locally (`npx wrangler login`).
- A **Microsoft Entra app registration** — walkthrough in [Microsoft Entra app
  registration](#microsoft-entra-app-registration) below. You'll need four values:
  `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `OWNER_EMAIL`.

### A note on the Cloudflare plan (free vs Paid)

The cross-list index is a **Durable Object backed by SQLite**, and the delta sync
writes one row per task (plus an FTS row) as it indexes. Cloudflare's **free tier
allows 100,000 Durable Object rows-written per day, account-wide**.

- **Small accounts** (a few hundred tasks) generally stay well under that and can
  run on the **free** plan.
- **Large accounts** (tasks in the **thousands**) can exceed the daily limit during
  a **full baseline** — the first sync after deploy, or a re-baseline triggered by
  an expired delta token (~30 days) or a manual `resync`. A baseline writes roughly
  `2 × (number of indexed tasks)` rows. Steady-state delta sync afterward is cheap.
- The budget is **account-wide**, so other Workers/Durable Objects on the same
  account (e.g. a second MCP server) share it.

When the budget is exhausted, **every** MCP request fails — the OAuth layer itself
writes a DO row per request, so it 500s before your tools even run.

**Recommendation:** if your To Do account has more than ~1–2k tasks, or you run
other DO-backed Workers on the same account, use the **Workers Paid** plan. You can
also reduce write pressure on any plan — see [Keeping sync cost
down](#keeping-sync-cost-down).

## Microsoft Entra app registration

The Worker talks to Microsoft Graph as a **confidential web app** using the
authorization-code flow with PKCE (S256) plus a client secret. Register one app in
the Microsoft Entra admin center (Azure portal → **App registrations** → **New
registration**) and collect four values for the Worker's secrets.

### 1. Create the registration

- **Name:** anything (e.g. `mstodo-mcp`).
- **Supported account types:** match the account you'll sign in with:
  - A single work/school tenant → *Accounts in this organizational directory only* (single tenant). `MS_TENANT_ID` = the **Directory (tenant) ID** GUID.
  - Personal Microsoft accounts / broad → use `common`, `organizations`, or `consumers` as `MS_TENANT_ID` and pick the matching account-types option.
  - The `OWNER_EMAIL` gate restricts the server to one identity regardless of how broad this setting is.
- **Redirect URI:** platform **Web** (not SPA — this is a confidential client). You
  set the exact value after deploying, once you know your Worker domain (see
  [step 6](#6-point-the-entra-redirect-uri-at-your-deployment)):
  `https://<your-worker-domain>/auth/microsoft/callback`.

### 2. API permissions

Add these **Microsoft Graph → Delegated** permissions (they must equal the `SCOPES`
constant in `src/auth/microsoft.ts`: `Tasks.ReadWrite offline_access User.Read`):

| Permission | Why |
|---|---|
| `Tasks.ReadWrite` | Read and write the owner's To Do lists/tasks. |
| `User.Read` | Read `/me` for the owner-identity gate. |
| `offline_access` | Issue refresh tokens (long-lived background sync). |

Grant admin consent if your tenant requires it for delegated permissions.

**Optional — My Day support.** If you plan to enable the opt-in "My Day" feature
(`ENABLE_MY_DAY=true`), also add one **Office 365 Exchange Online → Delegated**
permission. Exchange Online isn't selectable in most tenants' "Add a permission"
UI, so add it via the **Manifest** blade: append a second `requiredResourceAccess`
block, then save and **Grant admin consent**.

```jsonc
{
  "resourceAppId": "00000002-0000-0ff1-ce00-000000000000", // Office 365 Exchange Online
  "resourceAccess": [
    { "id": "6b49b74d-642f-4417-a6b4-820576845707", "type": "Scope" } // Tasks.ReadWrite
  ]
}
```

After saving, `Tasks.ReadWrite` appears under **API permissions → Office 365
Exchange Online**. This is only needed if you turn on My Day; leave it off
otherwise. See [My Day support](#my-day-support-optional) below.

### 3. Client secret

**Certificates & secrets → New client secret →** copy the secret **Value** (shown
only once) — this is `MS_CLIENT_SECRET`.

### 4. The four secrets

You'll put these in `.dev.vars` and push them in [step 4](#4-set-the-secrets):

| Secret | Where it comes from |
|---|---|
| `MS_TENANT_ID` | Directory (tenant) ID GUID, or `common`/`organizations`/`consumers`. |
| `MS_CLIENT_ID` | Application (client) ID on the registration's Overview. |
| `MS_CLIENT_SECRET` | The client-secret **Value** from step 3. |
| `OWNER_EMAIL` | The `mail` or `userPrincipalName` of the account allowed to use this server (case-insensitive; everyone else is rejected at `/authorize`). |

Switching to a different Microsoft account later is just `OWNER_EMAIL` (re-push, then
re-authorize — see [README → Reset](./README.md#reset)). Changing tenants means a new
registration and all four values.

## Steps

### 1. Clone and install

```bash
git clone https://github.com/dszp/mstodo-mcp-cloudflare.git
cd mstodo-mcp-cloudflare
npm install
```

### 2. Create the two KV namespaces

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create TODO_CACHE
```

Each command prints an `id`. Keep both. The **binding names must stay exactly**
`OAUTH_KV` (required by `workers-oauth-provider`) and `TODO_CACHE` (referenced by
this project's code) — only the namespace *titles* are yours to choose.

### 3. Configure Wrangler

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Edit `wrangler.jsonc` and fill in:
- `account_id` — your Cloudflare account ID (Dashboard → Workers, or `npx wrangler whoami`).
- the two `kv_namespaces[].id` values from step 2.
- `vars.SERVICE_BASE_URL` — the public origin this Worker is reachable at, used to build
  web upload links. Set it to your `https://mstodo-mcp.<your-subdomain>.workers.dev` (or
  custom domain). It ships as a placeholder; if you don't know the URL yet, deploy once
  (step 5), then set it and re-deploy. Needed for the web upload feature **and** for Graph
  change-notification subscriptions (below) — Graph validates the `notificationUrl` it derives
  (`${SERVICE_BASE_URL}/webhook`) at subscription-creation time, so it must be a reachable https URL.
- `vars.ENABLE_TASK_SUBSCRIPTIONS` — **ON by default.** Graph change-notification subscriptions
  (ROADMAP §4): the server stands up a public `POST /webhook` and creates one Graph subscription per
  list so task/My-Day edits land in ~2 minutes (Graph's `todoTask` latency) instead of waiting for
  the next delta cycle. **No new permission/consent** — it rides the existing delegated
  `Tasks.ReadWrite` scope. Delta polling stays as the mandatory backstop (Graph has no
  missed-notification safety net for `todoTask`). Set to `"false"` to stay timer-only — e.g. if you
  prefer not to expose a public webhook, or the tenant-wide Graph subscription budget (shared across
  all apps in the tenant) is spoken for. (`todoTask` has no documented per-resource cap — one
  subscription per list, e.g. ~38 here; if any tenant limit is ever hit, Graph returns `403` and
  that list quietly falls back to timer-only.) Requires a reachable `SERVICE_BASE_URL`; without one,
  subscription creation no-ops (logged) and the server falls back to timer-only automatically.

`wrangler.jsonc` is **gitignored** (it holds account-specific IDs). The committed
`wrangler.example.jsonc` is what the test pool and CI read, so `npm test` works
without it.

### 4. Set the secrets

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, OWNER_EMAIL
```

`.dev.vars` is for local `wrangler dev`. Push the same values to the deployed
Worker as encrypted secrets:

```bash
bash scripts/push-secrets.sh        # pushes every name from .dev.vars over stdin
# or individually: npx wrangler secret put MS_CLIENT_SECRET
```

Values in `.dev.vars` may be literals or **1Password secret references** (`op://<vault>/<item>/<field>`).
The push script resolves references via the `op` CLI at push time (`op signin`, or
`OP_SERVICE_ACCOUNT_TOKEN` for CI) and passes literals through unchanged — so you can avoid storing
secrets in the file at all.

**Optional — enable web attachment uploads.** To use `create_upload_link` / the `/upload`
endpoint, set `vars.SERVICE_BASE_URL` in `wrangler.jsonc` (step 3) to this Worker's real public
origin. That's the only configuration needed — upload links are unguessable capability tokens
stored in KV, so there is **no secret to set**. Leaving `SERVICE_BASE_URL` at the placeholder
keeps `create_upload_link` disabled.

### 5. Deploy

```bash
npx wrangler deploy
```

Note the deployed URL (`https://mstodo-mcp.<your-subdomain>.workers.dev`) and the
**Current Version ID** (your rollback reference).

### 6. Point the Entra redirect URI at your deployment

In the Entra app registration → **Authentication**, set the **Web** redirect URI to:

```
https://<your-worker-domain>/auth/microsoft/callback
```

It must match the deployed origin exactly. The OAuth entry point the Claude.ai
connector uses is `https://<your-worker-domain>/authorize`.

### 7. Connect from Claude.ai or your own AI MCP consumer

Add a custom / remote MCP connector pointing at:

```
https://<your-worker-domain>/mcp
```

Complete the Microsoft sign-in. The signed-in account's `mail`/`userPrincipalName`
**must match `OWNER_EMAIL`** (case-insensitive) or `/authorize` rejects it with 403.

### 8. Verify

In the connected client:
- `whoami` → returns your Microsoft identity.
- `sync_status` → watch it drain to `all_idle: true`. On a large account the first
  baseline takes several cron cycles (the `*/15` cron re-arms the sync alarm; a
  mid-cycle baseline re-arms every ~2s until caught up). `totals.tasks` climbs as
  lists index.
- `list_lists` / `query_tasks` → return data once the index warms.

## Optional: custom domain

Map a custom hostname to the Worker (Cloudflare dashboard → your Worker → Settings →
Domains & Routes, or `routes`/`custom_domain` in `wrangler.jsonc`). Then **update the
Entra redirect URI** (step 6) and the Claude.ai connector URL (step 7) to the custom
hostname. You can keep the `workers.dev` URL enabled as a fallback.

## Keeping sync cost down

If you're near the free-tier DO write budget, two `config:lists` knobs reduce
rows-written (full reference: [README → Configuration](./README.md#configuration)):

- **`sync_flagged_emails: false`** (the default) leaves the usually-huge
  `flaggedEmails` list unindexed.
- **`no_sync`** excludes any other large list you don't query (still readable
  on-demand via `list_tasks`): `set_list_config({ no_sync: ["<list id>"] })` — the
  next sync purges its already-indexed rows once, then steady state is lighter.

## My Day support (optional)

Microsoft To Do's "My Day" has no public Graph API. This Worker can drive it via an
**undocumented Microsoft Substrate endpoint** (`https://substrate.office.com/todob2/api/v1/`),
which uses the Office 365 Exchange Online resource rather than Graph. It's **opt-in
and off by default**; existing deployments are unaffected unless you enable it.

### What enabling My Day unlocks (and what it costs)

Turning on `ENABLE_MY_DAY` is a single decision with a clear, bounded set of extras. Here is
**everything** it changes, so you can weigh it deliberately:

**What you gain — six additional MCP tools** (all inert / hidden unless My Day is on):

| Tool | What it does |
| --- | --- |
| `add_to_my_day` | Put a task on My Day for a day (sets `CommittedDay`; seeds its My Day order to the top). |
| `remove_from_my_day` | Take a task off My Day. |
| `list_my_day_tasks` | List a day's My Day tasks, in the app's My Day drag order (cache-backed). |
| `list_tasks_by_manual_order` | List one list's tasks in the app's manual (drag-to-reorder) order. |
| `reorder_task` | Change a task's manual position **within its list** (`OrderDateTime`). |
| `reorder_my_day_task` | Change a task's manual position **within My Day** (`CommittedOrder`). |

Plus a behavior add-on: **`get_task` gains an opt-in `include_my_day`** flag that returns a task's
`committed_day` / `committed_order` (returns `null` while My Day is off). My Day tool responses
also surface the Substrate-only detail (`committed_day`, `committed_order`, `order_datetime`).

**What it costs:**

- **One extra delegated permission** on your Entra app — **Office 365 Exchange Online →
  `Tasks.ReadWrite`** (resource `00000002-0000-0ff1-ce00-000000000000`). This is **task data only**
  — it does **not** grant access to mail, calendar, contacts, or files. It's the same task data
  Graph already exposes, reached over a second API plane (Outlook/Exchange Online) because the My
  Day fields are invisible to Graph.
- **One re-consent.** The `/authorize` screen widens to cover both resources (Graph + Exchange
  Online) in a single combined consent; the one rotating refresh token then mints tokens for both
  audiences on demand. You must re-run `/authorize` once after enabling (see below).
- **A small background cost** — a budgeted Substrate "scan" (one request per list, capped per
  cycle) keeps the My Day cache current. The defaults are **free-tier-safe** (see the scan-budget
  note below); writes you make through this server are reflected instantly via write-through.
- **Reliance on an undocumented endpoint.** The Substrate API is not a public contract and
  Microsoft may change it without notice; the rest of the server (all Graph tools) is unaffected
  if it does, and the My Day tools degrade gracefully (`my_day_unavailable`) rather than crashing.

Leaving `ENABLE_MY_DAY` off keeps the server to the standard Graph `Tasks.ReadWrite` scope and the
~34 Graph-only tools — nothing above is requested, registered, or scanned.

To turn it on:

1. Add the **Office 365 Exchange Online → `Tasks.ReadWrite`** delegated permission to
   the Entra app via the Manifest (see [API permissions](#2-api-permissions) above) and
   grant admin consent.
2. Set `vars.ENABLE_MY_DAY` to `"true"` in `wrangler.jsonc` and `npx wrangler deploy`.
3. **Re-run `/authorize`.** Enabling the flag widens the consent request to include the
   Exchange Online scope; a single consent screen now covers both resources. Without a
   fresh authorize, the existing refresh token has Graph consent only and My Day calls
   fail with a re-consent message.

This registers the six My Day / manual-order tools and enables `get_task`'s `include_my_day`
option — see [What enabling My Day unlocks](#what-enabling-my-day-unlocks-and-what-it-costs) above
for the full list.

**My Day cache & scan budget — important for free accounts.** `list_my_day_tasks` reads from
the local SQLite cache (fast, zero Substrate calls on the read path). The cache is refreshed by
a background scan that issues **one Substrate request per list**. Because Cloudflare's **free
tier caps a Worker at 50 subrequests per request** — and the delta sync already uses up to ~41
of those — the scan is **budgeted by default so it can never push you over that ceiling**, no
matter how many lists you have. Two optional vars control it; the defaults are free-tier-safe,
so **on the free plan you should leave both as-is:**

- **`MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE`** (default `"6"`) — the most lists the scan touches in
  one sync cycle. At 6 the scan adds at most ~6 subrequests, and only on "calm" cycles (when no
  delta baseline is still draining), so a cycle stays well under 50 regardless of roster size. A
  large roster is just covered a few lists at a time, oldest-first, over several cycles. **On the
  Workers Paid plan** (1,000-subrequest ceiling) you can raise this — up to your list count — to
  refresh the whole roster every cycle for snappier off-device freshness.
- **`MY_DAY_SCAN_EVERY_N_CYCLES`** (default `"4"`) — how stale a list's cached My Day data may
  get before the scan re-reads it, in sync cycles (`× DELTA_SYNC_INTERVAL_MIN` ≈ hourly at the
  defaults). Raise it to scan less often (cheaper, staler); lower for fresher data at higher cost.

Note: changes you make **through this server** (`add_to_my_day` / `remove_from_my_day`) update
the cache instantly via write-through — the scan only catches My Day changes made in **other** To
Do clients. Right after deploy (or a re-baseline), `list_my_day_tasks` may return `count: 0` with
`stale: true` until the first scan completes (within a cycle or two).

**Timezone.** `My Day` membership is a local calendar date. When you call a My Day tool
without an explicit `date`, "today" is computed in the Worker's configured **`TIMEZONE`**
(an IANA name like `America/New_York`), **not UTC** — so set `TIMEZONE` to your own zone,
or pass an explicit `YYYY-MM-DD` to target a specific day.

**Graceful auto-disable.** The `ENABLE_MY_DAY` flag is operator intent; it doesn't prove
the Exchange Online permission was actually granted/consented. If it wasn't, the tools
detect this at runtime (Microsoft returns `AADSTS65001` at token mint, or `403` on the
write) and return `my_day_unavailable` with a re-consent hint instead of a raw error —
no crash, and the rest of the server is unaffected.

**Honest framing.** The Substrate endpoint is undocumented; this Worker mirrors the
official To Do client's network calls. Microsoft may change it without notice.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **My Day tools return `my_day_disabled`** | `ENABLE_MY_DAY` isn't `"true"`. Set it in `wrangler.jsonc`, deploy, and re-authorize. |
| **My Day tools return `my_day_unavailable`** | The Exchange Online `Tasks.ReadWrite` permission isn't consented/granted. Add it via the Manifest + admin consent (see [My Day support](#my-day-support-optional)), then re-run `/authorize`. |
| **`add_to_my_day` returns `ok:true` but the task doesn't appear in the app** | A task whose `PostponedDay == today` is suppressed from My Day even with `CommittedDay` set. `add_to_my_day` clears `PostponedDay` automatically, so this is handled — if you see it, confirm you're on the current deploy (the response includes `"postponed_day_raw": null` on success). |
| **`list_my_day_tasks` is slow, or returns `substrate_429` / partial results (`folders_errored > 0`)** | It walks every list one folder at a time to stay under EXO's `MailboxConcurrency` cap (parallel fan-out trips `429 ApplicationThrottled`). On accounts with many/large lists it's inherently slow — `add`/`remove` are single-call and fast. A non-zero `folders_errored` means some folders were skipped (throttle/transient); retry. This is the case for the deferred SQLite-`CommittedDay` indexing optimization. |
| **403 at `/authorize`** ("not the owner") | The signed-in Microsoft account doesn't match `OWNER_EMAIL`. Re-check the secret (`npx wrangler secret list`), re-push, and re-authorize. Switching accounts = update `OWNER_EMAIL` first. |
| **`SqlError: Exceeded allowed rows written in Durable Objects free tier`** (every call 500s) | The account's daily DO rows-written budget is exhausted (see [the plan note](#a-note-on-the-cloudflare-plan-free-vs-paid)). Upgrade to Workers Paid, or wait for the daily UTC reset, then reduce future cost via `sync_flagged_emails`/`no_sync`. |
| **`sync_status` never reaches `all_idle`** | A large baseline is still draining (normal — let the cron run), or a resource shows `status: "error"` with a `last_error`. A `sync_disabled` resource is intentionally skipped (`no_sync` / default-skipped `flaggedEmails`) and excluded from `all_idle`. |
| **Tools return empty right after deploy** | The index is still warming. `query_tasks`/`search_tasks` are empty until the first baseline lands; retry shortly or check `sync_status`. |
| **Claude.ai can't reconnect after changes** | Clear the Claude.ai-side OAuth grants (DCR sessions) — see [README → Reset](./README.md#reset) — then re-add the connector. |
| **Switched Microsoft accounts and data looks wiped** | Expected: the identity-change auto-wipe clears the prior account's index + tokens + aliases (see [README → Identity-change auto-wipe](./README.md#identity-change-auto-wipe-built-in)). The new account re-baselines on the next sync. |
| **Local `tsc` errors about `Env` / bindings** | The binding types live in the gitignored, generated `worker-configuration.d.ts`. Run `npx wrangler types` (or `npx wrangler types -c wrangler.example.jsonc`) after any `wrangler.jsonc` change. |

## Local development

```bash
npx wrangler types        # (re)generate worker-configuration.d.ts after config changes
npx tsc --noEmit          # typecheck
npm test                  # vitest (uses wrangler.example.jsonc; no secrets needed)
npx wrangler dev          # local Worker using .dev.vars
```

## Reset and teardown

See [README → Reset](./README.md#reset) for soft reset (re-auth), credential
rotation, and full clean-slate teardown.
