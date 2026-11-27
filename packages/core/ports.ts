// Host-neutral ports. Cloudflare bindings satisfy KeyValueStore structurally;
// the Node host supplies SQLite-backed adapters. Keep each interface to the
// calls core actually makes — adding a method here means writing it twice.

export interface KeyValueStore {
  get(key: string, type: "text"): Promise<string | null>;
  get<T = unknown>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface SqlCursor<T extends Record<string, SqlValue>> {
  toArray(): T[];
  one(): T; // throws when the result is not exactly one row, like Cloudflare's cursor
}

export interface SqlDb {
  exec<T extends Record<string, SqlValue> = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): SqlCursor<T>;
}
export type SqlValue = string | number | null | ArrayBuffer;

// Runs fn as one SQLite transaction: every write inside lands, or none does.
// Cloudflare: ctx.storage.transactionSync. Node: a savepoint on the one
// connection. fn must be synchronous; an exception rolls back and rethrows.
// Don't nest calls.
export type Transact = <T>(fn: () => T) => T;

// Push to connected app clients (docs/SYNC-API.md section 7). IndexCore calls
// announce() after writes that moved the change log, with the new cursor; the
// host fans it out to its open sockets. closeAll() ends every socket after a
// grant revocation or identity reset, so a client must authenticate again.
export interface ChangeNotifier {
  announce(cursor: string): void;
  closeAll(reason: "revoked" | "reset"): void;
  // Ends sockets whose token has expired. Run on each sync cycle.
  sweep(): void;
}

// The blob store (docs/SYNC-API.md section 4.9): attachment copies and theme
// images. R2 on Cloudflare; the shape is the part of R2Bucket core uses.
export interface BlobObject {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
}
export interface BlobStore {
  get(key: string): Promise<BlobObject | null>;
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface AlarmScheduler {
  getAlarm(): Promise<number | null>;
  setAlarm(epochMs: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

// The RPC surface core calls on the singleton index. Generated from IndexCore's
// public methods in Task 4 (`Pick<IndexCore, …>`); declared here as the type the
// rest of core depends on.
export type IndexBackend = import("./index/index-core").IndexBackendSurface;

// Vars and secrets core reads, plus the two stores. Cloudflare's Env is a
// structural superset; the Node host builds one from process.env.
export interface AppEnv {
  TIMEZONE: string;
  DELTA_SYNC_INTERVAL_MIN?: string;
  LIST_METADATA_SOFT_TTL_SEC?: string;
  SERVICE_BASE_URL?: string;
  ENABLE_MY_DAY?: string;
  ENABLE_DOWNLOAD_LINKS?: string;
  ENABLE_TASK_SUBSCRIPTIONS?: string;
  MAX_SUBSCRIPTION_OPS_PER_CYCLE?: string;
  MY_DAY_SCAN_EVERY_N_CYCLES?: string;
  MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE?: string;
  ENABLE_CHECKLIST_CACHE?: string;
  CHECKLIST_SCAN_MAX_TASKS_PER_CYCLE?: string;
  MS_TENANT_ID: string;
  MS_CLIENT_ID: string;
  MS_CLIENT_SECRET: string;
  OWNER_EMAIL: string;
  // Optional: the owner's Microsoft account object ID (/me.id). Required when
  // MS_TENANT_ID is `common` or `organizations`; see isOwner().
  OWNER_OBJECT_ID?: string;
  // Optional: Cloudflare Access in front of the app's paths (docs/SYNC-API.md
  // section 8.1). Both set turns the server-side check on; neither leaves it
  // off; one alone is refused as a misconfiguration. See core/auth/access.ts.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // The app redirect URIs (comma-separated, exact) that may receive the Access
  // token at code redemption. Empty: no hand-over. See hosts/shared/app-signin.ts.
  ACCESS_HANDOFF_REDIRECT_URIS?: string;
  // Optional: serve /.well-known/apple-app-site-association for the app's
  // https sign-in callback (section 8). Both set turns it on.
  APPLE_TEAM_ID?: string;
  APPLE_BUNDLE_IDS?: string;
  // Optional: without it attachments stream from Graph and theme images are
  // unavailable (section 4.9).
  BLOBS?: BlobStore;
  TODO_CACHE: KeyValueStore;
  OAUTH_KV: KeyValueStore;
  // Host hook: how core reaches the singleton index (see core/owner-index.ts).
  ownerIndex: () => IndexBackend;
}
