import { serve } from "@hono/node-server";
import { log } from "../../core/log";
import { openDatabase } from "./sqlite-db";
import { buildNodeEnv, InvalidConfigError, MissingConfigError, parsePublicOrigin } from "./env";
import { createHandler, startScheduler } from "./http";

// Node entry point. Configuration comes from process.env under the same names
// the Worker uses, plus MSTODO_DB (SQLite file) and PORT. SERVICE_BASE_URL is
// required: it is this deployment's public origin (https, or http on
// localhost for dev), and every request is served as if addressed to it. Only
// key names are ever logged, never values.
const dbPath = process.env.MSTODO_DB ?? "/data/mstodo.sqlite";
const port = Number(process.env.PORT ?? 8787);
const SHUTDOWN_TIMEOUT_MS = 10_000;

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
let built: ReturnType<typeof buildNodeEnv>;
try {
  built = buildNodeEnv(db, process.env);
} catch (e) {
  db.close();
  configError(e);
}
const { env, core, state } = built;

const scheduler = startScheduler(core, state);
const handler = createHandler(env, { publicOrigin });
const server = serve({ fetch: handler.fetch, port });
log.info("listening", { port, db: dbPath, public_origin: publicOrigin });

// Resolves when the server has closed (in-flight requests done) or after the
// timeout, whichever is first, so a hung connection cannot block shutdown.
function closeServer(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log.warn("shutdown_server_close_timeout", { timeout_ms: SHUTDOWN_TIMEOUT_MS });
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
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
  await scheduler.stop();
  await handler.drain();
  db.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
