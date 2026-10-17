import type { DatabaseSync } from "node:sqlite";
import type { AlarmScheduler, StateStore } from "../../core/ports";

const ALARM_KEY = "__alarm__";

// The Durable Object storage + alarm equivalents for the single IndexCore.
// The alarm is persisted so a restart re-arms it (Task 10 schedules the timer).
export function stateStore(
  db: DatabaseSync,
): StateStore & AlarmScheduler & { onAlarmChange(cb: (at: number | null) => void): void } {
  db.exec("CREATE TABLE IF NOT EXISTS do_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const getStmt = db.prepare("SELECT value FROM do_state WHERE key = ?");
  const putStmt = db.prepare(
    "INSERT INTO do_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const delStmt = db.prepare("DELETE FROM do_state WHERE key = ?");
  const listeners: Array<(at: number | null) => void> = [];
  const store = {
    async get<T>(key: string) {
      const row = getStmt.get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    async put<T>(key: string, value: T) {
      putStmt.run(key, JSON.stringify(value));
    },
    async delete(key: string) {
      return Number(delStmt.run(key).changes) > 0;
    },
    async getAlarm() {
      return (await store.get<number>(ALARM_KEY)) ?? null;
    },
    async setAlarm(at: number) {
      await store.put(ALARM_KEY, at);
      listeners.forEach((cb) => cb(at));
    },
    async deleteAlarm() {
      await store.delete(ALARM_KEY);
      listeners.forEach((cb) => cb(null));
    },
    onAlarmChange(cb: (at: number | null) => void) {
      listeners.push(cb);
    },
  };
  return store;
}
