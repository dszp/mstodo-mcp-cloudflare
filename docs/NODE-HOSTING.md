# Run on Node.js or Docker

This guide runs the MCP server as a single Node.js process instead of a Cloudflare Worker. The
tools, the OAuth consent flow, and the Microsoft sign-in are the same on both hosts. On Node, one
SQLite file holds everything the Worker keeps in KV and Durable Objects: the task cache, the
sealed Microsoft tokens, the MCP client grants, and the list configuration.

For the Cloudflare deployment, see the [deployment guide](../DEPLOYMENT.md). To decide where to
run the Node host and how to test it first, see [Choose a host](#choose-a-host).

## Prerequisites

You need the following:

- Docker or Podman, or Node.js 24 or later. Node 24 provides the built-in `node:sqlite` module
  that the server uses; there is no native SQLite dependency.
- For anything beyond local testing, a reverse proxy that serves the server over HTTPS at a
  public hostname, such as Caddy, nginx, or a Cloudflare Tunnel. Microsoft Entra ID accepts
  `http` redirect URIs only for `localhost`, and remote MCP clients such as Claude.ai connect
  over HTTPS.
- A Microsoft Entra app registration, set up as described in
  [Microsoft Entra app registration](../DEPLOYMENT.md#microsoft-entra-app-registration). The
  only difference on Node is the redirect URI, covered in the next section.

## Register the redirect URI

In the Entra app registration, go to **Authentication** and set the **Web** redirect URI to:

```text
https://HOST/auth/microsoft/callback
```

Replace `HOST` with the public hostname your reverse proxy serves. It must match
`SERVICE_BASE_URL` exactly, including any port. For local testing, register
`http://localhost:8787/auth/microsoft/callback` instead.

## Configure the environment

The server reads its settings from environment variables. The names are the same as the Worker's
secrets and `vars`; the Node host adds `MSTODO_DB`, `PORT`, and `HOST`.

These variables are required:

| Variable | Value |
| --- | --- |
| `SERVICE_BASE_URL` | The public `https` origin your reverse proxy serves, for example `https://todo.example.com`. |
| `MS_TENANT_ID` | The Entra directory (tenant) ID. |
| `MS_CLIENT_ID` | The Entra application (client) ID. |
| `MS_CLIENT_SECRET` | The Entra client secret value. |
| `OWNER_EMAIL` | The Microsoft account allowed to sign in. Every other account is refused before any token is stored. |

`SERVICE_BASE_URL` fixes the OAuth issuer, the token audience, and the Microsoft redirect URI.
The server ignores the `Host` and `X-Forwarded-*` request headers, so a request that arrives
under a different name can't change them. The server refuses to start if the value is missing,
isn't `https`, or has a path, query, or fragment; a trailing `/` is accepted. Plain `http` is
accepted only for `localhost` and `127.0.0.1`, for local testing.

These variables are optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TIMEZONE` | `UTC` | The IANA time zone for dates given without a zone, such as `America/New_York`. |
| `MSTODO_DB` | `/data/mstodo.sqlite` | Path of the SQLite database file. |
| `PORT` | `8787` | The HTTP port the server listens on. |
| `HOST` | `127.0.0.1` | The address the server binds. The container image sets `0.0.0.0` so the published port reaches it; Compose still publishes the port on `127.0.0.1` only. |

The Worker's feature and tuning variables, such as `ENABLE_MY_DAY`, `ENABLE_CHECKLIST_CACHE`,
`ENABLE_TASK_SUBSCRIPTIONS`, and `DELTA_SYNC_INTERVAL_MIN`, work the same way on Node. The
[deployment guide](../DEPLOYMENT.md) describes each one.

The database holds sealed Microsoft tokens, the MCP client grants, and the task cache in plain
text. The server creates it, and its `-wal` and `-shm` files, readable by its own user only
(mode `0600`). The token encryption key derives from `MS_CLIENT_SECRET`, so if you rotate the
secret, sign in to Microsoft again.

## Run with Docker Compose

The repository includes a Dockerfile and a Compose file in `src/hosts/node/`.

1. In `src/hosts/node/`, create a file named `.env` with your settings:

   ```text
   SERVICE_BASE_URL=https://HOST
   MS_TENANT_ID=TENANT_ID
   MS_CLIENT_ID=CLIENT_ID
   MS_CLIENT_SECRET=CLIENT_SECRET
   OWNER_EMAIL=OWNER_EMAIL
   TIMEZONE=America/New_York
   ```

   Replace each uppercase placeholder with your value. `TIMEZONE` is optional and defaults to
   `UTC`. The repository's `.gitignore` excludes `.env` files.

1. From `src/hosts/node/`, build and start the container:

   ```sh
   docker compose up -d --build
   ```

   The container runs as the unprivileged `node` user and keeps its database in the
   `mstodo-data` volume, mounted at `/data`. It listens on `127.0.0.1:8787` only, so it's
   reachable through your reverse proxy and not directly from the network.

1. Point your reverse proxy at `http://127.0.0.1:8787`.

1. Check that the server answers through the proxy:

   ```sh
   curl https://HOST/health
   ```

   The response is a JSON object that includes `"ok":true` and `"host":"node"`.

If you build with Podman, add `--format docker` to `podman build`. Podman's default OCI image
format drops the `HEALTHCHECK` instruction.

## Run without Docker

To run the server directly on Node.js 24 or later:

1. Install the dependencies and build the bundle:

   ```sh
   npm ci
   npm run build:node
   ```

   The build writes `dist/main.mjs`.

1. Set the environment variables from [Configure the environment](#configure-the-environment),
   including `MSTODO_DB` if `/data` doesn't exist on this machine.

1. Start the server:

   ```sh
   npm run start:node
   ```

The server listens on `127.0.0.1` unless you set `HOST`. Keep it on loopback behind a reverse
proxy; setting `HOST=0.0.0.0` exposes plain-HTTP OAuth and MCP traffic to your network.

Run it under a service manager such as systemd so that it restarts after a failure. On `SIGTERM`
or `SIGINT`, the server stops taking requests, finishes in-flight work, and closes the database,
within about 25 seconds. Give the service manager a stop timeout of at least 30 seconds; the
Compose file sets `stop_grace_period: 30s`.

## Connect an MCP client

Add a connector in your MCP client with the URL `https://HOST/mcp`. The first connection opens
the same consent page as the Worker: you approve the client, then sign in to Microsoft as the
owner account. See
[Connect from Claude.ai or your own AI MCP consumer](../DEPLOYMENT.md#7-connect-from-claudeai-or-your-own-ai-mcp-consumer)
for the client side.

## Run one instance only

Run exactly one server process per database file. The server serializes Microsoft token
refreshes and the sync loop inside one process, and a second process would run its own refreshes
and sync cycles alongside the first.

The server enforces this rule. At startup it claims a lock row in the database and refreshes it
every 20 seconds. A second process that opens the same file logs `instance_lock_refused` and
exits with a non-zero status. A process releases the lock whenever it exits, including after a
fatal error. If a process is killed without exiting cleanly, for example with `kill -9`, a new
process can take over 60 seconds after the last refresh. Until then, a restart fails and your
service manager retries it.

The lock is a lease. A process whose event loop stalls for more than 60 seconds can lose it to a
new process, and exits when its next refresh finds that the lock has moved.

The Compose file sets `replicas: 1`. Don't scale the service, and don't point two containers at
the same volume.

## Request size limits

The server caps every request body before routing it, because a Node process has no platform
limit like a Worker's. A request over its cap gets HTTP `413`:

| Path | Cap |
| --- | --- |
| `/mcp` | 4 MiB |
| `/upload` | 61 MiB (the 60 MiB upload batch limit plus multipart framing) |
| `/register`, `/token`, `/authorize`, `/auth/*`, `/.well-known/*`, `/webhook` | 64 KiB |
| Everything else | 1 MiB |

An `/upload` POST that carries neither a `?t=` link token nor a `Content-Length` header gets
HTTP `400`.

Set a body limit in your reverse proxy as well, such as `client_max_body_size` in nginx or
`request_body { max_size }` in Caddy, sized to the `/upload` cap. Rate limits on `/register`,
`/token`, and `/authorize` also help: dynamic client registration is open by design.

## Back up the database

The database uses SQLite's write-ahead log, so recent changes can sit in `mstodo.sqlite-wal`
rather than in the main file. Copying `mstodo.sqlite` alone while the server runs can produce an
incomplete backup. Use one of these methods:

- Stop the container or process, then copy `mstodo.sqlite` together with any
  `mstodo.sqlite-wal` and `mstodo.sqlite-shm` files.
- Make an online backup while the server runs, with Node's SQLite backup function:

  ```sh
  docker compose exec mstodo-mcp node --input-type=module -e \
    "import { DatabaseSync, backup } from 'node:sqlite'; await backup(new DatabaseSync('/data/mstodo.sqlite'), '/data/mstodo-backup.sqlite')"
  ```

  Then copy `/data/mstodo-backup.sqlite` out of the volume. Without Docker, run the same
  `node` command with your `MSTODO_DB` path.

Treat backups as secrets. They contain sealed Microsoft tokens and the MCP client grants.

## Differences from the Cloudflare Worker

The tools and their inputs and outputs are identical. The hosting differs in these ways:

- **Logs.** Workers Observability isn't available. The server writes the same structured JSON
  log lines to standard output and standard error; collect them with `docker logs` or your
  service manager.
- **Scheduling.** A timer in the process replaces the Durable Object alarm and the 15-minute
  cron. The sync schedule is stored in the database, so a restart resumes it. When a sync run
  fails, the server retries it 60 seconds later; Cloudflare retries a failed alarm with its own
  backoff. The 15-minute timer also deletes expired OAuth records from the database.
- **Limits.** Cloudflare's per-invocation subrequest budget and the free-tier tuning advice in the
  deployment guide don't apply. The tuning variables still control how much work each sync cycle
  does.
- **Scale.** One process serves one owner. There is no multi-replica mode.
- **Request bodies.** The server enforces its own size caps; see
  [Request size limits](#request-size-limits).

## Known limitations

- Registered MCP clients never expire, on either host. Each client registration adds a small row
  to the database.

## Choose a host

### Test in three stages

1. **Local.** Run `docker compose up` with `SERVICE_BASE_URL=http://localhost:8787` and
   `ENABLE_TASK_SUBSCRIPTIONS=false`, because Microsoft Graph can't deliver change notifications
   to `localhost`. Use a test Entra app registration with the redirect URI
   `http://localhost:8787/auth/microsoft/callback`. Connect a client from the same machine:

   ```sh
   claude mcp add --transport http NAME http://localhost:8787/mcp
   ```

   Approve the consent page in Chrome or Firefox. Safari refuses the consent cookie over plain
   `http`, so the consent step fails there until you use an `https` origin.

   To get a public `https` origin without opening ports, use Tailscale Funnel or a Cloudflare
   Tunnel, and set `SERVICE_BASE_URL` and the redirect URI to that origin.

1. **Public HTTPS host.** Deploy to the host you chose, with `SERVICE_BASE_URL` set to its
   `https` origin, and connect your real MCP client.

1. **Failure checks.** Restart the server during a sync and confirm that sync resumes. Start a
   second copy on the same volume and confirm that it logs `instance_lock_refused` and exits.

### Requirements for any host

- Exactly one replica.
- A volume on block storage for the database. SQLite's write-ahead log needs local file
  locking.
- On redeploy, stop the old process before the new one starts. Otherwise the new process
  waits for the lock, for up to 60 seconds.

If you lose the database, you sign in again, reconnect each MCP client, and wait for a full
resync.

### A virtual machine

A small VM, such as a Vultr instance, an Azure B1s or B2s, or a Proxmox VM, is the simplest fit.
Run the same `compose.yaml` with `docker compose` or `podman compose`, and put Caddy or an
existing reverse proxy in front for TLS. Back up with `sqlite3 DB_PATH ".backup BACKUP_PATH"` or
with the container stopped. Never copy a live write-ahead-log database file.

### Railway

Deploy from the Dockerfile, attach a volume at `/data`, set the variables, and use the Railway
`https` domain as `SERVICE_BASE_URL`. Check Railway's current documentation for how volumes
limit replicas and whether a deploy overlaps the old and new containers.

### Azure Container Apps and App Service

Not recommended with their persistent storage. Both use Azure Files, an SMB or NFS network
share, and SQLite in write-ahead-log mode isn't safe on a network share: the database can be
corrupted. Container Apps also overlaps revisions during a deploy unless you use single-revision
mode with minimum and maximum replicas set to 1; otherwise the lock refuses the new revision for
up to 60 seconds.
