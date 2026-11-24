// Shared spike body, run against both hosts' SQLite (see the two
// sync-spike-sqlite tests). Uses only the SqlDb port, so it is host-neutral.
import type { SqlDb } from "../src/core/ports";

export function runSyncLogSpike(sql: SqlDb) {
  sql.exec(`CREATE TABLE IF NOT EXISTS spike_items (id TEXT PRIMARY KEY, title TEXT, marker INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS spike_map (graph_id TEXT PRIMARY KEY, sid TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS spike_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    sid TEXT NOT NULL UNIQUE,
    deleted INTEGER NOT NULL DEFAULT 0)`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS spike_ai AFTER INSERT ON spike_items BEGIN
    INSERT OR IGNORE INTO spike_map (graph_id, sid) VALUES (new.id, lower(hex(randomblob(16))));
    INSERT OR REPLACE INTO spike_log (sid, deleted)
      SELECT sid, 0 FROM spike_map WHERE graph_id = new.id;
  END`);
  // Fires only when a synced column changed; marker writes log nothing.
  sql.exec(`CREATE TRIGGER IF NOT EXISTS spike_au AFTER UPDATE ON spike_items
    WHEN old.title IS NOT new.title BEGIN
    INSERT OR REPLACE INTO spike_log (sid, deleted)
      SELECT sid, 0 FROM spike_map WHERE graph_id = new.id;
  END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS spike_ad AFTER DELETE ON spike_items BEGIN
    INSERT OR REPLACE INTO spike_log (sid, deleted)
      SELECT sid, 1 FROM spike_map WHERE graph_id = old.id;
  END`);

  sql.exec("INSERT INTO spike_items VALUES ('a', 'one', 0)");
  sql.exec("INSERT INTO spike_items VALUES ('b', 'two', 0)");
  const sid = sql.exec<{ sid: string }>("SELECT sid FROM spike_map WHERE graph_id = 'a'").one().sid;

  sql.exec("UPDATE spike_items SET title = 'one!' WHERE id = 'a'");
  const sidStableAcrossUpdate =
    sql.exec<{ sid: string }>("SELECT sid FROM spike_map WHERE graph_id = 'a'").one().sid === sid;

  const before = sql.exec<{ n: number }>("SELECT max(seq) n FROM spike_log").one().n;
  sql.exec("UPDATE spike_items SET marker = 1 WHERE id = 'b'");
  const noLogOnUnchangedUpdate =
    sql.exec<{ n: number }>("SELECT max(seq) n FROM spike_log").one().n === before;

  const seqs = sql.exec<{ seq: number }>("SELECT seq FROM spike_log ORDER BY seq").toArray().map((r) => r.seq);

  // AUTOINCREMENT must not reuse a seq after the highest row is deleted.
  const maxBeforeDelete = sql.exec<{ n: number }>("SELECT max(seq) n FROM spike_log").one().n;
  sql.exec("DELETE FROM spike_log WHERE seq = ?", maxBeforeDelete);
  sql.exec("UPDATE spike_items SET title = 'two!' WHERE id = 'b'");
  const seqAfterDeleteOfMax = sql.exec<{ n: number }>("SELECT max(seq) n FROM spike_log").one().n;

  sql.exec("DELETE FROM spike_items WHERE id = 'a'");
  const tombstoneDeleted = sql
    .exec<{ deleted: number }>("SELECT deleted FROM spike_log WHERE sid = ?", sid)
    .one().deleted;

  return { sid, sidStableAcrossUpdate, noLogOnUnchangedUpdate, seqs, maxBeforeDelete, seqAfterDeleteOfMax, tombstoneDeleted };
}
