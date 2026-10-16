# Run on Node.js or Docker

This guide runs the MCP server as a single Node.js process instead of a Cloudflare Worker. The
tools, the OAuth consent flow, and the Microsoft sign-in are the same on both hosts. On Node, one
SQLite file holds everything the Worker keeps in KV and Durable Objects: the task cache, the
sealed Microsoft tokens, the MCP client grants, and the list configuration.

For the Cloudflare deployment, see the [deployment guide](../DEPLOYMENT.md).

## Prerequisites

You need the following:

- Docker or Podman, or Node.js 24 or later. Node 24 provides the built-in `node:sqlite` module
  that the server uses; there is no native SQLite dependency.
- A reverse proxy that serves the server over HTTPS at a public hostname, such as Caddy, nginx,
  or a Cloudflare Tunnel. Microsoft Entra ID accepts only `https` redirect URIs for this app, and
  MCP clients such as Claude.ai connect over HTTPS.
- A Microsoft Entra app registration, set up as described in
  [Microsoft Entra app registration](../DEPLOYMENT.md#microsoft-entra-app-registration). The
  only difference on Node is the redirect URI, covered in the next section.

## Register the redirect URI

In the Entra app registration, go to **Authentication** and set the **Web** redirect URI to:

```text
https://HOST/auth/microsoft/callback
```

Replace `HOST` with the public hostname your reverse proxy serves. It must match
`SERVICE_BASE_URL` exactly, including any port.

## Configure the environment

The server reads its settings from environment variables. The names are the same as the Worker's
secrets and `vars`; the Node host adds `MSTODO_DB` and `PORT`.

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
under a different name can't change them. The server refuses to start if the value is missing or
isn't `https`. Plain `http` is accepted only for `localhost` and `127.0.0.1`, for local testing.

These variables are optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TIMEZONE` | `UTC` | The IANA time zone for dates given without a zone, such as `America/New_York`. |
| `MSTODO_DB` | `/data/mstodo.sqlite` | Path of the SQLite database file. |
| `PORT` | `8787` | The HTTP port the server listens on. |

The Worker's feature and tuning variables, such as `ENABLE_MY_DAY`, `ENABLE_CHECKLIST_CACHE`,
`ENABLE_TASK_SUBSCRIPTIONS`, and `DELTA_SYNC_INTERVAL_MIN`, work the same way on Node. The
[deployment guide](../DEPLOYMENT.md) describes each one.

The database holds sealed Microsoft tokens and the MCP client grants. The token encryption key
derives from `MS_CLIENT_SECRET`, so if you rotate the secret, sign in to Microsoft again.

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

   Replace each uppercase placeholder with your value. The repository's `.gitignore` excludes
   `.env` files.

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

Run it under a service manager such as systemd so that it restarts after a failure. On `SIGTERM`
or `SIGINT`, the server stops taking requests, finishes in-flight work, and closes the database.

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
exits with a non-zero status. If a process stops without releasing the lock, for example after a
crash or `kill -9`, a new process can take over 60 seconds after the last refresh. Until then, a
restart fails and your service manager retries it.

The Compose file sets `replicas: 1`. Don't scale the service, and don't point two containers at
the same volume.

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
  cron. The sync schedule is stored in the database, so a restart resumes it.
- **Limits.** Cloudflare's per-invocation subrequest budget and the free-tier tuning advice in the
  deployment guide don't apply. The tuning variables still control how much work each sync cycle
  does.
- **Scale.** One process serves one owner. There is no multi-replica mode.
