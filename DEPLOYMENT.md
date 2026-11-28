# Deployment guide

A step-by-step walkthrough for running your own Potem server instance, plus a
troubleshooting section. For the feature/config reference and the MCP tool list,
see [README.md](./README.md).

## Contents

- [Deployment guide](#deployment-guide)
  - [Contents](#contents)
  - [Prerequisites](#prerequisites)
    - [A note on the Cloudflare plan (free vs Paid)](#a-note-on-the-cloudflare-plan-free-vs-paid)
  - [Microsoft Entra app registration](#microsoft-entra-app-registration)
    - [1. Create the registration](#1-create-the-registration)
    - [2. API permissions](#2-api-permissions)
    - [3. Client secret](#3-client-secret)
    - [4. The four secrets](#4-the-four-secrets)
  - [Steps](#steps)
    - [1. Clone and install](#1-clone-and-install)
    - [2. Create the KV namespaces and the bucket](#2-create-the-kv-namespaces-and-the-bucket)
    - [3. Describe the deployment](#3-describe-the-deployment)
    - [4. Write the secrets file](#4-write-the-secrets-file)
    - [5. Deploy](#5-deploy)
    - [6. Push the secrets](#6-push-the-secrets)
    - [7. Point the Entra redirect URI at your deployment](#7-point-the-entra-redirect-uri-at-your-deployment)
    - [8. Connect from Claude.ai or your own AI MCP consumer](#8-connect-from-claudeai-or-your-own-ai-mcp-consumer)
    - [9. Verify](#9-verify)
  - [Optional: custom domain](#optional-custom-domain)
  - [Optional: Cloudflare Access for the sync app](#optional-cloudflare-access-for-the-sync-app)
  - [Web client](#web-client)
  - [Keeping sync cost down](#keeping-sync-cost-down)
  - [My Day support (optional)](#my-day-support-optional)
    - [What enabling My Day unlocks (and what it costs)](#what-enabling-my-day-unlocks-and-what-it-costs)
  - [Troubleshooting](#troubleshooting)
  - [Local development](#local-development)
  - [Reset and teardown](#reset-and-teardown)

## Prerequisites

- **Node 24.2 or later** and **pnpm** (the version `packageManager` in `package.json` names; `corepack enable` installs it. Wrangler 4 is pinned in `devDependencies`). The test suite and the Node host use Node 24's built-in `node:sqlite` module.
- A **Cloudflare account**, logged in locally (`pnpm exec wrangler login`).
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

- **Name:** anything (e.g. `potem-server`).
- **Supported account types:** match the account you'll sign in with:
  - A single work/school tenant → *Accounts in this organizational directory only* (single tenant). `MS_TENANT_ID` = the **Directory (tenant) ID** GUID.
  - Personal Microsoft accounts / broad → use `common`, `organizations`, or `consumers` as `MS_TENANT_ID` and pick the matching account-types option.
  - The owner gate restricts the server to one identity regardless of how broad this setting is. With `common` or `organizations`, it also requires `OWNER_OBJECT_ID`, because an administrator of any tenant can give an account the owner's address.
- **Redirect URI:** platform **Web** (not SPA — this is a confidential client). You
  set the exact value after deploying, once you know your Worker domain (see
  [step 7](#7-point-the-entra-redirect-uri-at-your-deployment)):
  `https://<your-worker-domain>/auth/microsoft/callback`.

### 2. API permissions

Add these **Microsoft Graph → Delegated** permissions (they must equal the `SCOPES`
constant in `packages/core/auth/microsoft.ts`: `Tasks.ReadWrite offline_access User.Read`):

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

The entire section for `requiredResourceAccess` with all the required permissions including the above, should look like this to enable My Day support and several other features this enables that are not available via the normal Graph API (such as moving tasks positionally within lists, and others):

```jsonc
	"requiredResourceAccess": [
		{
			"resourceAppId": "00000002-0000-0ff1-ce00-000000000000",
			"resourceAccess": [
				{
					"id": "6b49b74d-642f-4417-a6b4-820576845707",
					"type": "Scope"
				}
			]
		},
		{
			"resourceAppId": "00000003-0000-0000-c000-000000000000",
			"resourceAccess": [
				{
					"id": "7427e0e9-2fba-42fe-b0c0-848c9e6a8182",
					"type": "Scope"
				},
				{
					"id": "2219042f-cab5-40cc-b0d2-16b1540b4c5f",
					"type": "Scope"
				},
				{
					"id": "e1fe6dd8-ba31-4d61-89e7-88639da4683d",
					"type": "Scope"
				}
			]
		}
	],
  ```

After saving, `Tasks.ReadWrite` appears under **API permissions → Office 365
Exchange Online**. This is only needed if you turn on My Day; leave it off
otherwise. See [My Day support](#my-day-support-optional) below.

Ensure after all permission changes (including the above custom edit) that you go to the **API Permissions** blade and click "Grant admin consent" and confirm the Status column shows Granted for all the listed permissions.

### 3. Client secret

**Certificates & secrets → New client secret →** copy the secret **Value** (shown
only once) — this is `MS_CLIENT_SECRET`.

### 4. The four secrets

You'll put these in `deployments/<name>/.dev.vars` and push them in [step 6](#6-push-the-secrets):

| Secret | Where it comes from |
|---|---|
| `MS_TENANT_ID` | Directory (tenant) ID GUID, or `common`/`organizations`/`consumers`. |
| `MS_CLIENT_ID` | Application (client) ID on the registration's Overview. |
| `MS_CLIENT_SECRET` | The client-secret **Value** from step 3. |
| `OWNER_EMAIL` | The `userPrincipalName` of the account allowed to use this server (case-insensitive; everyone else is rejected at `/authorize`). It can be the account's `mail` address instead only when `OWNER_OBJECT_ID` is also set. |
| `OWNER_OBJECT_ID` | Optional, unless `MS_TENANT_ID` is `common` or `organizations`, or `OWNER_EMAIL` is the `mail` address rather than the `userPrincipalName`. The account's object ID: the `id` that the `whoami` tool returns, or **Object ID** on the user's Entra profile. When set, sign-in also requires this ID, not just the address. |

Switching to a different Microsoft account later is just `OWNER_EMAIL`, plus `OWNER_OBJECT_ID` if you set it (re-push, then
re-authorize — see [README → Reset](./README.md#reset)). Changing tenants means a new
registration and all four values.

## Steps

### 1. Clone and install

```bash
git clone https://github.com/dszp/potem-server.git
cd potem-server
pnpm install
```

### 2. Create the KV namespaces and the bucket

```bash
pnpm exec wrangler kv namespace create OAUTH_KV
pnpm exec wrangler kv namespace create TODO_CACHE
pnpm exec wrangler r2 bucket create <bucket-name>     # optional: the BLOBS attachment store
```

Each KV command prints an `id`. Keep both. The **binding names must stay exactly**
`OAUTH_KV` (required by `workers-oauth-provider`) and `TODO_CACHE` (referenced by
this project's code); only the namespace *titles* are yours to choose. The bucket is
optional: set `"BLOBS": null` in step 3 to leave it out.

### 3. Describe the deployment

Each deployment is a folder under `deployments/<name>/`, which is gitignored because it
holds account-specific IDs. `<name>` is lowercase letters, digits and hyphens. The
commands below render `workers/server/wrangler.example.jsonc` plus this folder's `deployment.jsonc` into
a wrangler config, check it, write it to `.wrangler/deployments/<name>/rendered.json` and run
wrangler against it. A deployment that fails a check gets no `rendered.json`, and a stale one
is removed. `pnpm run render <name>` prints the config without writing it. There is no root
`wrangler.jsonc`.

```bash
mkdir -p deployments/<name>
cp deployment.example.jsonc deployments/<name>/deployment.jsonc
```

`deployments/` and the `last-deployed.json` each deploy records are local to this checkout.
Deploy from your main checkout, not from a git worktree: a worktree starts without them, so a
deploy there finds no deployment file, and one copied in has no `last-deployed.json`, so the
deploy shows every setting as new.

Edit `deployment.jsonc` and fill in:
- `account_id`: your Cloudflare account ID (Dashboard → Workers, or `pnpm exec wrangler whoami`).
  Wrangler takes the account from this value. The script also sets `CLOUDFLARE_ACCOUNT_ID` for
  the wrangler processes it starts, and refuses to run if your shell already sets a different one.
- `worker_name`, `base_url` (the public https origin the Worker is reachable at) and
  `custom_domains`. `base_url` becomes `vars.SERVICE_BASE_URL`, used to build web upload links.
  It is also needed for Graph change-notification subscriptions (below): Graph validates the
  `notificationUrl` derived from it (`${SERVICE_BASE_URL}/webhook`) when it creates a
  subscription, so it must be a reachable https URL.
- `workers_dev` and `preview_urls`: whether the `workers.dev` address and preview URLs are on.
- `kv`: the two namespace IDs from step 2. `r2`: the bucket name from step 2, or `null`.
- `vars` (optional): overrides for any var in `workers/server/wrangler.example.jsonc`, as strings. The
  other vars, including `ENABLE_TASK_SUBSCRIPTIONS`, keep the example's values.

`vars.ENABLE_TASK_SUBSCRIPTIONS` is **ON by default.** Graph change-notification subscriptions
(ROADMAP §4): the server stands up a public `POST /webhook` and creates one Graph subscription per
list so task/My-Day edits land in ~2 minutes (Graph's `todoTask` latency) instead of waiting for
the next delta cycle. **No new permission/consent**: it rides the existing delegated
`Tasks.ReadWrite` scope. Delta polling stays as the mandatory backstop (Graph has no
missed-notification safety net for `todoTask`). Set it to `"false"` in `vars` to stay timer-only,
for example if you prefer not to expose a public webhook, or the tenant-wide Graph subscription
budget (shared across all apps in the tenant) is spoken for. (`todoTask` has no documented
per-resource cap: one subscription per list, e.g. ~38 here; if any tenant limit is ever hit, Graph
returns `403` and that list quietly falls back to timer-only.)

A deployment is a server unless `deployment.jsonc` says `"kind": "web"`, the web client Worker;
[Web client](#web-client) describes that file, its secret and how to deploy it.

The committed `workers/server/wrangler.example.jsonc` is the template for every deployment and what the test
pool and CI read, so `pnpm test` works without any deployment. A new binding added there reaches
every deployment on its next deploy, once the deployment file supplies its ID.

### 4. Write the secrets file

```bash
cp .dev.vars.example deployments/<name>/.dev.vars
# edit it: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, OWNER_EMAIL
```

The same file feeds `pnpm run dev <name>` and `pnpm run secrets <name>` (step 6).
A value may be a literal or a **1Password secret reference** (`op://<vault>/<item>/<field>`).
The scripts resolve references with the `op` CLI (`op signin`, or `OP_SERVICE_ACCOUNT_TOKEN`
for CI) and pass literals through unchanged, so the file never has to hold a secret. Set
`op_account` in `deployment.jsonc` if you use more than one 1Password account.

Check the deployment before anything changes:

```bash
pnpm run check <name>
```

`check` renders the config, validates it against your other deployments and the shell, and
reads the live Worker (read-only) to compare KV bindings, custom domains, `workers_dev` and
preview URLs. It exits 1, and writes no `rendered.json`, when a custom domain conflicts, when
a deploy would detach a custom domain that is attached live but missing from `custom_domains`,
or when `workers_dev` or `preview_urls` differs from the live value. When everything passes it
writes `rendered.json`.

Run `check` before any direct `pnpm exec wrangler ... -c .wrangler/deployments/<name>/rendered.json`
command (KV keys, `secret list`, `delete`). Those commands get no account or identity checks
beyond that `check`, so run them from a shell where `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ENV`
and `WRANGLER_CI_OVERRIDE_NAME` are unset, and keep those variables out of a root `.env` or
`.env.local`, which wrangler also loads. It reports a missing Worker as "no live Worker yet", which is the expected
answer before the first deploy.

### 5. Deploy

```bash
pnpm run deploy <name>
```

The first deploy shows the vars and bindings it will send (and, for a Worker that already
exists, the live `workers_dev`, preview URL and custom-domain settings) and asks you to confirm.
Every deploy also asks before it detaches a custom domain missing from `custom_domains` or
changes `workers_dev` or `preview_urls` from the live value; `--non-interactive` refuses both. `deploy` needs an
interactive terminal (stdin and stdout on a TTY, `CI` unset). From a script, pass
`--non-interactive`, which refuses any config change you haven't seen on an earlier
interactive deploy. Pass `--adopt` only to take over an existing Worker whose KV bindings
don't match this deployment's file. `pnpm run dry-run <name>` builds without uploading.

Note the deployed URL and the **Current Version ID** (your rollback reference). The script
records the config it deployed in `deployments/<name>/last-deployed.json` and shows the
difference at the next deploy.

### 6. Push the secrets

```bash
pnpm run secrets <name>
```

The Worker must already be deployed: `secrets` refuses to run until it exists, because
`wrangler secret put` would otherwise create an empty draft Worker. It resolves every
non-empty secret first, then pipes each to `wrangler secret put` over stdin, so values never
appear in argv, the environment, terminal scrollback or AI transcripts. Verify with
`pnpm exec wrangler secret list -c .wrangler/deployments/<name>/rendered.json`.

**Optional: enable web attachment uploads.** To use `create_upload_link` / the `/upload`
endpoint, set `base_url` in `deployment.jsonc` (step 3) to this Worker's real public
origin. That's the only configuration needed: upload links are unguessable capability tokens
stored in KV, so there is **no secret to set**.

### 7. Point the Entra redirect URI at your deployment

In the Entra app registration → **Authentication**, set the **Web** redirect URI to:

```
https://<your-worker-domain>/auth/microsoft/callback
```

It must match the deployed origin exactly. The OAuth entry point the Claude.ai
connector uses is `https://<your-worker-domain>/authorize`.

### 8. Connect from Claude.ai or your own AI MCP consumer

Add a custom / remote MCP connector pointing at:

```
https://<your-worker-domain>/mcp
```

Complete the Microsoft sign-in. The signed-in account's `userPrincipalName` **must match
`OWNER_EMAIL`** (case-insensitive), or its `mail` must match with `OWNER_OBJECT_ID` set, or
`/authorize` rejects it with 403.

### 9. Verify

In the connected client:
- `whoami` → returns your Microsoft identity.
- `sync_status` → watch it drain to `all_idle: true`. On a large account the first
  baseline takes several cron cycles (the `*/15` cron re-arms the sync alarm; a
  mid-cycle baseline re-arms every ~2s until caught up). `totals.tasks` climbs as
  lists index.
- `list_lists` / `query_tasks` → return data once the index warms.

## Optional: custom domain

Map a custom hostname to the Worker (Cloudflare dashboard → your Worker → Settings →
Domains & Routes), or list it in `custom_domains` and `base_url` in `deployment.jsonc`
and deploy again. Then **update the Entra redirect URI** (step 7) and the Claude.ai connector URL (step 8) to the custom
hostname. You can keep the `workers.dev` URL enabled as a fallback.

## Optional: Cloudflare Access for the sync app

The sync API (`/api/v1/*`) and the app's sign-in path (`/app/signin`) can sit behind
Cloudflare Access as a second gate in front of OAuth. MCP clients aren't affected:
`/mcp` and the OAuth endpoints stay outside Access. The server-side check is off until
you set both variables. Set them under `vars` in `deployment.jsonc`
and run `pnpm run deploy <name>`; they default to empty, which leaves Access off.

| Variable | Value |
|---|---|
| `ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain, `<team>.cloudflareaccess.com`. |
| `ACCESS_AUD` | The Access application's audience (AUD) tag. |
| `ACCESS_HANDOFF_REDIRECT_URIS` | The app's exact sign-in callback URIs, comma-separated. Only these receive the Access token at sign-in; empty, `/app/signin` refuses every request. |

With both set, the Worker verifies the Access JWT on every `/api/v1` request (signature
against the team's keys, audience, issuer, expiry, and `email` equal to `OWNER_EMAIL`),
so a gap in the Access application's paths fails closed. With only one set, those paths
answer `503`. The Access application, its policy and the identity provider are set up
in the Cloudflare dashboard; [docs/SYNC-API.md section 8.1](./docs/SYNC-API.md#81-cloudflare-access-in-front-of-the-app)
lists the steps under **Turning it on**.

For the app's `https` sign-in callback, the Worker can also serve
`/.well-known/apple-app-site-association`. Set `APPLE_TEAM_ID` (the 10-character Apple
team ID) and `APPLE_BUNDLE_IDS` (comma-separated bundle IDs). Unset, the path is a 404.

## Web client

The web client is a second Worker, `workers/web`, that serves the Potem web app and signs in to
your server on your behalf. It shows lists, tasks, task detail and search, and edits tasks: it
adds and deletes them, moves them between lists, and changes titles, notes, due dates,
reminders, importance, steps, completion and My Day. Edits go to the server's sync API
through one `POST` route, `/bff/api/sync/mutations`, and the page asks before you close a tab
with unsent edits. Sign out first sends unsent edits for up to 3 seconds, then discards what is
left. An HTML note is read-only in the web client; edit it in the app. The rest of that task
can still be edited. The browser never holds a Microsoft or server token. The Worker
keeps the tokens in a sealed, HttpOnly cookie and forwards a fixed set of `GET` requests, and
that one `POST`, to the server's sync API. Editing needs no new variable, secret or binding: a
web deployment that already works edits after you deploy this version.

Live updates need nothing configured either: the page keeps a WebSocket open to the web
Worker's `/bff/socket`, which relays the server's push socket, so a change made in the app or
on another device shows up within seconds. If the socket can't connect, the page polls every
30 seconds instead. A relayed socket is one Worker invocation that lasts as long as the page
stays open. On Workers Paid that costs a request plus a little CPU per message. On the Free
plan the invocation's CPU limit may end the socket after a while; the page reconnects and falls
back to the 30-second poll, so nothing breaks. The Node web host (a later milestone) will need
its own socket relay, because the Cloudflare one uses the Workers WebSocket API.

**Before you start**

- A deployed server (steps 1 to 9 above), reachable over https. The web Worker needs its origin.
- A hostname for the web Worker, for example `todo-web.example.com`, on a zone in your Cloudflare
  account. The cookies are bound to that exact host, so use one hostname only. The Worker sends
  `Strict-Transport-Security: max-age=31536000` for that host only (no `includeSubDomains` or
  `preload`), so browsers that have visited it refuse plain http to it for a year.
- Optional: put Cloudflare Access in front of that hostname as a second gate. Add a bypass
  policy for `/robots.txt` so crawlers see the Worker's `Disallow: /`.

**Describe the deployment**

Create `deployments/<name>/deployment.jsonc` with `"kind": "web"`. A web deployment has no `kv`
or `r2` (leave them out), and `base_url` becomes the Worker's own origin:

```jsonc
{
  "kind": "web",
  "account_id": "00000000000000000000000000000000",
  "worker_name": "potem-web",
  "base_url": "https://todo-web.example.com",
  "workers_dev": false,
  "preview_urls": false,
  "custom_domains": ["todo-web.example.com"],
  "vars": {
    "SERVER_ORIGIN": "https://todo.example.com"
  },
  // Optional, same account only: the server Worker's name. The web Worker then
  // reaches the server through a service binding instead of the public network.
  "server_service": "potem-server"
}
```

`SERVER_ORIGIN` is an https origin with no path or trailing slash. Three more vars are optional:
`WEB_SESSION_MAX_HOURS` (default `12`) is the longest a sign-in lasts, and
`WEB_SESSION_IDLE_MINUTES` (default `60`) is how long a browser can sit idle before it must
sign in again. Both are positive whole numbers. `WEB_ICON` picks the app icon the page and the
browser tab show: `blue` (the default) or `teal`, for a development deployment, like the apps'
Dev builds.

**The secret**

`WEB_SESSION_SECRET` seals the cookies. It must be at least 32 bytes; the Worker answers every
request with `503` until it is. Generate one and put it in `deployments/<name>/.dev.vars`:

```bash
echo "WEB_SESSION_SECRET=$(openssl rand -base64 48)" >> deployments/<name>/.dev.vars
```

A value may also be an `op://` reference, as for the server's secrets. Changing the secret signs
every browser out, because no cookie unseals under the new key.

**Deploy**

```bash
pnpm run check <name>      # validates the file and reads the live Worker
pnpm run deploy <name>     # builds the app; the first deploy asks you to confirm, in a terminal
pnpm run secrets <name>    # pushes WEB_SESSION_SECRET; refuses until the Worker exists
```

Open the Worker's hostname. The first visit shows a signed-out page with a **Sign in** link.
Select it to go to the server's consent page, which names the client "Potem Web" and shows the
web hostname. Approve it, then sign in with Microsoft if asked. Each browser registers its own client with the server, so a second browser
gets its own consent page and signing in there does not end the first one's session.

**Signing out**

Sign out in the app: it revokes that browser's grant on the server and clears the cookie.
`revoke_all_connections` on the server changes the grant epoch, which every grant must match,
so it also ends every web session; each browser's next request is refused and it signs in
again.

Without a sign-out, the cookie stops working at the session limits (`WEB_SESSION_MAX_HOURS`
after sign-in, or `WEB_SESSION_IDLE_MINUTES` without use), and an open page signs itself out at
the same moments. The grant on the server outlives the cookie: it lasts until its refresh token
lapses, 14 days after the session's last refresh (30 days after sign-in if it was never
refreshed), and the server refuses any grant more than 90 days after sign-in. Sign out to end
it at once.

**With Cloudflare Access on the web hostname**

When the Access session for the web hostname expires, the page's requests to the Worker fail
and the page shows its error screen. Reload the page: the reload goes through Access, which asks
you to sign in again if its policy requires it.

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
2. Set `"ENABLE_MY_DAY": "true"` under `vars` in `deployment.jsonc` and run `pnpm run deploy <name>`.
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

**Timezone.** Set **`TIMEZONE`** (an IANA name like `America/New_York`) to your own zone. The
server reads a time you give it without a `Z` or UTC offset as local time in that zone: a
`reminder` on `create_task` / `update_task`, datetime bounds and `created_after` in
`query_tasks`, and "today" for the My Day tools when you don't pass a `date`. Due, start and
completion are calendar dates in To Do — Graph drops any time of day — so `due: "2026-10-20"`
means the 20th in every zone.

**Checklist-item cache — opt-in (`ENABLE_CHECKLIST_CACHE`, default `"false"`).** Set it to
`"true"` to mirror task checklist items into a queryable table, enabling `search_checklist_items`
and the `query_tasks` `has_open_checklist_item` filter (use checklist items as a follow-up system:
add "waiting on X", then find what's still open, oldest first). It's off by default because
enabling it triggers a **one-time per-task backfill** — Graph has no `hasChecklist` flag and delta
carries no checklist data, so each task's checklist is fetched once with a Graph GET. Like the My
Day scan, the backfill is **budgeted**: `CHECKLIST_SCAN_MAX_TASKS_PER_CYCLE` (default `"8"`,
free-tier-safe) caps how many tasks the scan fetches per calm cycle, draining the backlog
newest-first over several cycles (open tasks only; completed tasks fill in lazily if queried). It is
**independent of `ENABLE_TASK_SUBSCRIPTIONS`** — the change signal is the delta cycle, so the cache
stays fresh on the timer; subscriptions just lower latency. Steady state is ~one GET per changed
task. **On the Workers Paid plan** raise the cap for a faster initial backfill. Right after
enabling, the new tools return partial results until the backfill drains. Watch the
`checklist_scan_batch` events in Workers observability to see the backlog shrink to zero.

What the cache covers, **by design**: **open tasks in non-skipped lists only.** Tasks with no
checklist items are still visited once (then marked done, so the scan converges); any task that
later changes rides `$delta` and is re-fetched (~one GET per changed task). **Completed tasks are
intentionally excluded** from the cross-task checklist cache — checklist follow-ups are an
open-task concern, so `search_checklist_items` / `query_tasks has_open_checklist_item` never surface
a completed task's items (`get_task` still returns any single task's checklist live). Lists in the
`no_sync` / Flagged-Emails skip set are never cached.

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
| **My Day tools return `my_day_disabled`** | `ENABLE_MY_DAY` isn't `"true"`. Set it under `vars` in `deployment.jsonc`, deploy, and re-authorize. |
| **My Day tools return `my_day_unavailable`** | The Exchange Online `Tasks.ReadWrite` permission isn't consented/granted. Add it via the Manifest + admin consent (see [My Day support](#my-day-support-optional)), then re-run `/authorize`. |
| **`add_to_my_day` returns `ok:true` but the task doesn't appear in the app** | A task whose `PostponedDay == today` is suppressed from My Day even with `CommittedDay` set. `add_to_my_day` clears `PostponedDay` automatically, so this is handled — if you see it, confirm you're on the current deploy (the response includes `"postponed_day_raw": null` on success). |
| **`list_my_day_tasks` is slow, or returns `substrate_429` / partial results (`folders_errored > 0`)** | It walks every list one folder at a time to stay under EXO's `MailboxConcurrency` cap (parallel fan-out trips `429 ApplicationThrottled`). On accounts with many/large lists it's inherently slow — `add`/`remove` are single-call and fast. A non-zero `folders_errored` means some folders were skipped (throttle/transient); retry. This is the case for the deferred SQLite-`CommittedDay` indexing optimization. |
| **403 at `/authorize`** ("not the owner") | The signed-in Microsoft account doesn't match `OWNER_EMAIL`. Re-check the secret (`pnpm exec wrangler secret list -c .wrangler/deployments/<name>/rendered.json`), re-push, and re-authorize. Switching accounts = update `OWNER_EMAIL` first. |
| **`SqlError: Exceeded allowed rows written in Durable Objects free tier`** (every call 500s) | The account's daily DO rows-written budget is exhausted (see [the plan note](#a-note-on-the-cloudflare-plan-free-vs-paid)). Upgrade to Workers Paid, or wait for the daily UTC reset, then reduce future cost via `sync_flagged_emails`/`no_sync`. |
| **`sync_status` never reaches `all_idle`** | A large baseline is still draining (normal — let the cron run), or a resource shows `status: "error"` with a `last_error`. A `sync_disabled` resource is intentionally skipped (`no_sync` / default-skipped `flaggedEmails`) and excluded from `all_idle`. |
| **Tools return empty right after deploy** | The index is still warming. `query_tasks`/`search_tasks` are empty until the first baseline lands; retry shortly or check `sync_status`. |
| **Claude.ai can't reconnect after changes** | Clear the Claude.ai-side OAuth grants (DCR sessions) — see [README → Reset](./README.md#reset) — then re-add the connector. |
| **Switched Microsoft accounts and data looks wiped** | Expected: the identity-change auto-wipe clears the prior account's index + tokens + aliases (see [README → Identity-change auto-wipe](./README.md#identity-change-auto-wipe-built-in)). The new account re-baselines on the next sync. |
| **Local `tsc` errors about `Env` / bindings** | The binding types live in the gitignored, generated `worker-configuration.d.ts`. Run `pnpm run types` (it reads `workers/server/wrangler.example.jsonc`, as CI does) after any change to the example's bindings. |

## Local development

```bash
pnpm run types             # (re)generate worker-configuration.d.ts from workers/server/wrangler.example.jsonc
pnpm exec tsc --noEmit          # typecheck
pnpm test                  # vitest (uses workers/server/wrangler.example.jsonc; no secrets needed)
pnpm run dev <name>     # local Worker using deployments/<name>/.dev.vars
```

## Reset and teardown

See [README → Reset](./README.md#reset) for soft reset (re-auth), credential
rotation, and full clean-slate teardown.
