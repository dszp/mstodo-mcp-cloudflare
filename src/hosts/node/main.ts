import { serve } from "@hono/node-server";
import { log } from "../../core/log";
import { openDatabase } from "./sqlite-db";
import { buildNodeEnv, MissingConfigError } from "./env";
import { createHandler, startScheduler } from "./http";

// Node entry point. Configuration comes from process.env under the same names
// the Worker uses, plus MSTODO_DB (SQLite file) and PORT. SERVICE_BASE_URL is
// this deployment's public https origin; behind a TLS reverse proxy the
// handler rewrites each request to it (see createHandler). Only key names are
// ever logged, never values.
const dbPath = process.env.MSTODO_DB ?? "/data/mstodo.sqlite";
const port = Number(process.env.PORT ?? 8787);

let built;
const db = openDatabase(dbPath);
try {
  built = buildNodeEnv(db, process.env);
} catch (e) {
  if (e instanceof MissingConfigError) {
    log.error("config_missing", { missing: e.missing });
    process.exit(1);
  }
  throw e;
}
const { env, core, state } = built;

const scheduler = startScheduler(core, state);
const handler = createHandler(env, { publicOrigin: process.env.SERVICE_BASE_URL || undefined });
const server = serve({ fetch: handler.fetch, port });
log.info("listening", { port, db: dbPath, public_origin: process.env.SERVICE_BASE_URL ?? null });

// Stop taking requests, let deferred work finish, then close the database so
// the WAL is checkpointed.
async function shutdown(signal: string) {
  log.info("shutdown", { signal });
  server.close();
  await scheduler.stop();
  await handler.drain();
  db.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
