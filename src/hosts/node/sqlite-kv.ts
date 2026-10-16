import type { DatabaseSync } from "node:sqlite";
import type { KeyValueStore } from "../../core/ports";

// The KV surface @cloudflare/workers-oauth-provider uses on OAUTH_KV: core's
// KeyValueStore plus the Workers KV spellings core never needs — get(key),
// get(key, { type }), and put's absolute `expiration` (epoch seconds), which
// the library sets on grants. Kept out of core's port on purpose.
export type OAuthKvStore = KeyValueStore & {
  get(key: string): Promise<string | null>;
  get(key: string, options: { type: "text" }): Promise<string | null>;
  get<T = unknown>(key: string, options: { type: "json" }): Promise<T | null>;
  put(key: string, value: string, options?: { expiration?: number; expirationTtl?: number; metadata?: unknown }): Promise<void>;
};

// One table for every namespace (TODO_CACHE, OAUTH_KV). Expired rows read as
// missing immediately; sweep() deletes them.
export function sqliteKv(
  db: DatabaseSync,
  namespace: string,
  now: () => number = Date.now,
): OAuthKvStore & { sweep(): void } {
  db.exec(`CREATE TABLE IF NOT EXISTS kv (
    ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    expires_at INTEGER, metadata TEXT, PRIMARY KEY (ns, key))`);
  const live = "ns = ? AND (expires_at IS NULL OR expires_at > ?)";
  const getStmt = db.prepare(`SELECT value FROM kv WHERE ${live} AND key = ?`);
  const putStmt = db.prepare(
    `INSERT INTO kv (ns, key, value, expires_at, metadata) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, metadata = excluded.metadata`,
  );
  const delStmt = db.prepare("DELETE FROM kv WHERE ns = ? AND key = ?");
  const listStmt = db.prepare(
    `SELECT key, expires_at, metadata FROM kv WHERE ${live} AND key > ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?`,
  );
  const sweepStmt = db.prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?");

  // Overloads cover both core's get(key, "json") and the Workers KV spellings
  // the OAuth library uses (see OAuthKvStore), so the object below needs no cast.
  async function get(key: string): Promise<string | null>;
  async function get(key: string, type: "text" | { type: "text" }): Promise<string | null>;
  async function get<T = unknown>(key: string, type: "json" | { type: "json" }): Promise<T | null>;
  async function get(key: string, type?: "text" | "json" | { type: "text" | "json" }): Promise<unknown> {
    const row = getStmt.get(namespace, now(), key) as { value: string } | undefined;
    if (!row) return null;
    const as = typeof type === "object" ? type.type : type;
    return as === "json" ? JSON.parse(row.value) : row.value;
  }

  return {
    get,
    async put(key: string, value: string, options?: { expiration?: number; expirationTtl?: number; metadata?: unknown }) {
      // Workers KV: expirationTtl (seconds from now) wins over expiration
      // (absolute epoch seconds) when both are given.
      const ttl = options?.expirationTtl;
      const at = options?.expiration;
      putStmt.run(
        namespace,
        key,
        value,
        ttl ? now() + ttl * 1000 : at ? at * 1000 : null,
        options?.metadata === undefined ? null : JSON.stringify(options.metadata),
      );
    },
    async delete(key) {
      delStmt.run(namespace, key);
    },
    async list(options = {}) {
      const prefix = options.prefix ?? "";
      const limit = Math.min(options.limit ?? 1000, 1000);
      const rows = listStmt.all(namespace, now(), options.cursor ?? "", prefix.length, prefix, limit + 1) as Array<{
        key: string;
        expires_at: number | null;
        metadata: string | null;
      }>;
      const page = rows.slice(0, limit);
      const more = rows.length > limit;
      return {
        keys: page.map((r) => ({
          name: r.key,
          ...(r.expires_at ? { expiration: Math.floor(r.expires_at / 1000) } : {}),
          ...(r.metadata ? { metadata: JSON.parse(r.metadata) as unknown } : {}),
        })),
        list_complete: !more,
        ...(more ? { cursor: page[page.length - 1].key } : {}),
      };
    },
    sweep() {
      sweepStmt.run(now());
    },
  };
}
