import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { log } from "../../core/log";

// One process per database file. The token refresh chain and the sync loop in
// IndexCore are serialized in memory, so a second process on the same file
// would run its own refreshes and sync cycles concurrently with the first.
// A row in instance_lock names the holder; the holder refreshes heartbeat_at
// every HEARTBEAT_MS, and a row whose heartbeat is older than ttlMs belongs to
// a process that died without releasing it and may be taken over.
const HEARTBEAT_MS = 20_000;
const DEFAULT_TTL_MS = 60_000;

export interface InstanceLock {
  release(): void;
}

export function acquireInstanceLock(
  db: DatabaseSync,
  ttlMs: number = DEFAULT_TTL_MS,
  onLost: () => void = () => {},
): InstanceLock {
  const holder = randomUUID();
  db.exec("CREATE TABLE IF NOT EXISTS instance_lock (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, heartbeat_at INTEGER NOT NULL)");

  // BEGIN IMMEDIATE takes the write lock up front, so two processes starting
  // at once cannot both read "free" and both claim it.
  db.exec("BEGIN IMMEDIATE");
  try {
    const now = Date.now();
    const row = db.prepare("SELECT holder, heartbeat_at FROM instance_lock WHERE id = 1").get() as
      | { holder: string; heartbeat_at: number }
      | undefined;
    if (row && now - row.heartbeat_at < ttlMs) throw new Error("another instance holds the database");
    db.prepare("INSERT OR REPLACE INTO instance_lock (id, holder, heartbeat_at) VALUES (1, ?, ?)").run(holder, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // Every statement is scoped to our holder id: if another process took the
  // lock over (our heartbeat stalled past ttlMs), we neither refresh nor
  // delete its row, and onLost tells the caller to stop.
  // A failed write (e.g. SQLITE_BUSY past busy_timeout) is logged and retried
  // on the next beat rather than thrown out of the timer, which would crash
  // the process; two missed beats still leave a margin under the 60 s ttl.
  const beat = setInterval(() => {
    let changes: number | bigint;
    try {
      ({ changes } = db
        .prepare("UPDATE instance_lock SET heartbeat_at = ? WHERE id = 1 AND holder = ?")
        .run(Date.now(), holder));
    } catch (e) {
      log.warn("instance_lock_heartbeat_failed", { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (Number(changes) === 0) {
      clearInterval(beat);
      onLost();
    }
  }, HEARTBEAT_MS);
  beat.unref();

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(beat);
      db.prepare("DELETE FROM instance_lock WHERE id = 1 AND holder = ?").run(holder);
    },
  };
}
