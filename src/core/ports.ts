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

export interface SqlCursor<T> {
  toArray(): T[];
  one(): T; // throws when the result is not exactly one row, like Cloudflare's cursor
}

export interface SqlDb {
  exec<T = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): SqlCursor<T>;
}
export type SqlValue = string | number | null | ArrayBuffer;

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
export type IndexBackend = import("../cache/index-do").IndexBackendSurface;

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
  TODO_CACHE: KeyValueStore;
  OAUTH_KV: KeyValueStore;
  // Host hook: how core reaches the singleton index (see core/owner-index.ts).
  ownerIndex?: () => IndexBackend;
}
