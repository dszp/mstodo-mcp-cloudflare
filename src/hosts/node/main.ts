import { serve } from "@hono/node-server";
import { log } from "../../core/log";
import { openDatabase } from "./sqlite-db";
import { buildNodeEnv, InvalidConfigError, MissingConfigError, parsePublicOrigin } from "./env";
import { createHandler, startScheduler } from "./http";
import { acquireInstanceLock, type InstanceLock } from "./single-instance";
import { sweepKv } from "./sqlite-kv";
import { installProcessHandlers, withTimeout } from "./lifecycle";

// Node entry point. Configuration comes from process.env under the same names
// the Worker uses, plus MSTODO_DB (SQLite file), PORT and HOST. SERVICE_BASE_URL
// is required: it is this deployment's public origin (https, or http on
// localhost for dev), and every request is served as if addressed to it. Only
// key names are ever logged, never values.

// Files this process creates are owner-only. The database holds the plaintext
// task cache and OAuth grant records, and SQLite gives its -wal and -shm files
// the main file's mode. Set before the database is opened.
process.umask(0o077);

const dbPath = process.env.MSTODO_DB ?? "/data/mstodo.sqlite";
const port = Number(process.env.PORT ?? 8787);
// Loopback by default, so a bare-metal start is not reachable from the network
// until HOST says so. The container image sets HOST=0.0.0.0, and Compose still
// publishes the port on 127.0.0.1 only.
const hostname = process.env.HOST || "127.0.0.1";
// Shutdown budget, under Compose's 30 s stop_grace_period: in-flight requests
// 10 s, a running sync alarm 10 s, deferred webhook work 4 s.
const SERVER_CLOSE_TIMEOUT_MS = 10_000;
const SCHEDULER_STOP_TIMEOUT_MS = 10_000;
const DRAIN_TIMEOUT_MS = 4_000;

function configError(e: unknown): never {
  if (e instanceof MissingConfigError) log.error("config_missing", { missing: e.missing });
  else if (e instanceof InvalidConfigError) log.error("config_invalid", { key: e.key, reason: e.reason });
  else throw e;
  process.exit(1);
}

let publicOrigin: string;
try {
  // Checked before the database is opened, so a bad config touches nothing.
  publicOrigin = parsePublicOrigin(process.env.SERVICE_BASE_URL);
} catch (e) {
  configError(e);
}
const db = openDatabase(dbPath);
// Claimed before anything else touches the database: a second process on the
// same file would run its own token refreshes and sync loop alongside ours.
let lock: InstanceLock;
try {
  lock = acquireInstanceLock(db, undefined, () => {
    log.error("instance_lock_lost", { db: dbPath });
    process.exit(1);
  });
} catch (e) {
  log.error("instance_lock_refused", { db: dbPath, error: e instanceof Error ? e.message : String(e) });
  db.close();
  process.exit(1);
}
// From here on every exit path releases the lock (see lifecycle.ts).
installProcessHandlers(lock);
let built: ReturnType<typeof buildNodeEnv>;
try {
  built = buildNodeEnv(db, process.env);
} catch (e) {
  lock.release();
  db.close();
  configError(e);
}
const { env, core, state } = built;

sweepKv(db);
const scheduler = startScheduler(core, state, { maintenance: () => sweepKv(db) });
const handler = createHandler(env, { publicOrigin });
const server = serve({ fetch: handler.fetch, port, hostname });
// A failed listen (EADDRINUSE, EACCES) is fatal; exiting runs the lock release.
server.once("error", (e) => {
  log.error("listen_failed", { host: hostname, port, error: e.message });
  process.exit(1);
});
server.once("listening", () => log.info("listening", { host: hostname, port, db: dbPath, public_origin: publicOrigin }));

// Resolves when the server has closed (in-flight requests done) or after the
// timeout, whichever is first, so a hung connection cannot block shutdown.
function closeServer(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log.warn("shutdown_server_close_timeout", { timeout_ms: SERVER_CLOSE_TIMEOUT_MS });
      resolve();
    }, SERVER_CLOSE_TIMEOUT_MS);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Stop taking requests, let in-flight and deferred work finish, then close the
// database so the WAL is checkpointed.
async function shutdown(signal: string) {
  log.info("shutdown", { signal });
  await closeServer();
  await withTimeout(scheduler.stop(), SCHEDULER_STOP_TIMEOUT_MS, () =>
    log.warn("shutdown_scheduler_timeout", { timeout_ms: SCHEDULER_STOP_TIMEOUT_MS }),
  );
  await withTimeout(handler.drain(), DRAIN_TIMEOUT_MS, () =>
    log.warn("shutdown_drain_timeout", { timeout_ms: DRAIN_TIMEOUT_MS }),
  );
  lock.release();
  db.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
