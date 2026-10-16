import type { DatabaseSync } from "node:sqlite";
import type { KeyValueStore } from "../../core/ports";

// One table for every namespace (TODO_CACHE, OAUTH_KV). Expired rows read as
// missing immediately; sweep() deletes them.
export function sqliteKv(
  db: DatabaseSync,
  namespace: string,
  now: () => number = Date.now,
): KeyValueStore & { sweep(): void } {
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

  // Overloads mirror KeyValueStore.get, so the object below needs no cast.
  async function get(key: string, type: "text"): Promise<string | null>;
  async function get<T = unknown>(key: string, type: "json"): Promise<T | null>;
  async function get(key: string, type: "text" | "json"): Promise<unknown> {
    const row = getStmt.get(namespace, now(), key) as { value: string } | undefined;
    if (!row) return null;
    return type === "json" ? JSON.parse(row.value) : row.value;
  }

  return {
    get,
    async put(key, value, options) {
      const ttl = options?.expirationTtl;
      putStmt.run(
        namespace,
        key,
        value,
        ttl ? now() + ttl * 1000 : null,
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
