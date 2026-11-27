// Shared change-log assertions (docs/SYNC-API.md section 3), run on both hosts'
// SQLite through IndexCore. Returns named facts so each host's test can assert
// them one by one.
import type { IndexCore } from "../src/core/index/index-core";
import type { SqlDb } from "../src/core/ports";

const t = (id: string, title: string, modified: string) =>
  ({ id, title, status: "notStarted", lastModifiedDateTime: modified }) as never;

export function runChangeLogChecks(c: IndexCore, sql: SqlDb) {
  const log = (kind: string, graphId: string) =>
    sql
      .exec<{ seq: number; deleted: number; list_sid: string | null; sid: string }>(
        `SELECT l.seq, l.deleted, l.list_sid, l.sid FROM sync_log l
           JOIN entity_map m ON m.kind = l.kind AND m.sid = l.sid
          WHERE l.kind = ? AND m.graph_id = ?`,
        kind,
        graphId,
      )
      .toArray()[0];

  c.upsertList({ id: "L1", displayName: "One" } as never);
  c.upsertTask(t("T1", "a", "2026-11-24T10:00:00Z"), "L1");
  const list = log("list", "L1");
  const task0 = log("task", "T1");

  c.upsertTask(t("T1", "b", "2026-11-24T10:01:00Z"), "L1");
  const task1 = log("task", "T1");
  c.markChecklistDirty("T1"); // marker-only write
  const task2 = log("task", "T1");

  c.upsertChecklistItem("T1", "L1", { id: "S1", displayName: "step" } as never);
  const task3 = log("task", "T1");
  c.upsertChecklistItem("T1", "L1", { id: "S1", displayName: "step", isChecked: true } as never);
  const task4 = log("task", "T1");

  c.moveTask("T1", "L2", "T1b");
  const moved = log("task", "T1b");

  c.deleteTask("T1b"); // cascades to the step
  const gone = log("task", "T1b");
  c.upsertTask(t("T1b", "back", "2026-11-24T10:05:00Z"), "L1");
  const back = log("task", "T1b");

  return {
    listLogged: !!list && list.deleted === 0,
    taskCarriesListSid: task0?.list_sid === list?.sid,
    updateMovesSeq: task1.seq > task0.seq,
    markerWriteLogsNothing: task2.seq === task1.seq,
    stepInsertBumpsTask: task3.seq > task2.seq,
    stepUpdateBumpsTask: task4.seq > task3.seq,
    moveKeepsSid: moved?.sid === task0.sid,
    deleteWritesTombstone: gone?.deleted === 1 && gone.sid === task0.sid,
    stepCascadeDoesNotRevive: gone?.deleted === 1,
    reinsertRevivesSameSid: back?.deleted === 0 && back.sid === task0.sid && back.seq > gone.seq,
  };
}
