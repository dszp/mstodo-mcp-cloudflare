import type { DatabaseSync } from "node:sqlite";
import type { AppEnv, IndexBackend } from "../../core/ports";
import { IndexCore } from "../../core/index/index-core";
import { sqlDb } from "./sqlite-db";
import { sqliteKv, type OAuthKvStore } from "./sqlite-kv";
import { stateStore } from "./state-store";

// The env the Node host hands core and the OAuth library. OAUTH_KV carries the
// extra Workers KV spellings the library calls (see OAuthKvStore).
export type NodeEnv = AppEnv & { OAUTH_KV: OAuthKvStore };

// The in-process IndexCore seen through the same surface core gets from the
// Durable Object stub on Cloudflare: every method returns a Promise (a few are
// synchronous in-process, so `.then()` on their raw result would throw), and
// the host lifecycle methods — alarm() is the scheduler's, bootstrap() runs
// once below — are not reachable through it, as they are not over DO RPC.
const NOT_ON_SURFACE = new Set<PropertyKey>(["alarm", "bootstrap", "constructor"]);

export function indexBackend(core: IndexCore): IndexBackend {
  return new Proxy({} as IndexBackend, {
    get(_target, key) {
      if (NOT_ON_SURFACE.has(key)) return undefined;
      const member: unknown = Reflect.get(core, key);
      if (typeof member !== "function") return undefined;
      return async (...args: unknown[]) => (member as (...a: unknown[]) => unknown).apply(core, args);
    },
  });
}

// Secrets core cannot run without. Checked here rather than in main.ts so no
// caller can build an env whose crypto keys derive from an empty secret or
// whose owner gate compares against nothing.
export const REQUIRED_VARS = ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "OWNER_EMAIL"] as const;

export class MissingConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing required configuration: ${missing.join(", ")}`);
  }
}

export class InvalidConfigError extends Error {
  constructor(
    readonly key: string,
    readonly reason: string,
  ) {
    super(`Invalid configuration ${key}: ${reason}`);
  }
}

// The public origin the OAuth front is served under (SERVICE_BASE_URL). It
// becomes the token audience, the Microsoft redirect_uri and the cookie
// context, so it comes from configuration only, never from a request's Host.
// https is required; plain http only for a loopback host during local dev.
export function parsePublicOrigin(raw: string | undefined, key = "SERVICE_BASE_URL"): string {
  if (!raw) throw new MissingConfigError([key]);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidConfigError(key, "not an absolute URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new InvalidConfigError(key, "must be https (http is allowed only for localhost or 127.0.0.1)");
  }
  return url.origin;
}

// vars: process.env on a real start. Throws MissingConfigError (names only,
// never values) when a required secret is absent or empty.
export function buildNodeEnv(db: DatabaseSync, vars: Record<string, string | undefined>) {
  const missing = REQUIRED_VARS.filter((k) => !vars[k]);
  if (missing.length) throw new MissingConfigError(missing);
  const state = stateStore(db);
  // Assigned below; IndexCore needs env, and env.ownerIndex needs the core.
  let backend: IndexBackend;
  const env: NodeEnv = {
    ...(vars as Partial<AppEnv>),
    TIMEZONE: vars.TIMEZONE || "UTC",
    MS_TENANT_ID: vars.MS_TENANT_ID!,
    MS_CLIENT_ID: vars.MS_CLIENT_ID!,
    MS_CLIENT_SECRET: vars.MS_CLIENT_SECRET!,
    OWNER_EMAIL: vars.OWNER_EMAIL!,
    TODO_CACHE: sqliteKv(db, "TODO_CACHE"),
    OAUTH_KV: sqliteKv(db, "OAUTH_KV"),
    ownerIndex: () => backend,
  };
  const core = new IndexCore({ sql: sqlDb(db), state, alarms: state, env });
  backend = indexBackend(core);
  core.bootstrap();
  return { env, core, state };
}
