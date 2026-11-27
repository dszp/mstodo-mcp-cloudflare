// The attachment cache shared by the Claude connector's paths (get_attachment,
// /download, upload links, the cross-list move): read the blob store's copy
// first, fill it from Graph on a miss, and keep a copy of what the connector
// attaches. A real IndexCore on node SQLite and an in-memory blob store.
import { describe, it, expect } from "vitest";
import { IndexCore } from "../src/core/index/index-core";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { attachmentBlobKey } from "../src/core/blobs";
import { keepAttachment, readAttachment } from "../src/core/attachment-cache";
import { memoryBlobs } from "./_memory-blobs";

const BYTES = new TextEncoder().encode("receipt bytes");

function setup(opts: { blobs?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const sql = sqlDb(db);
  const state = stateStore(db);
  const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC", TODO_CACHE: { get: async () => null } } as never });
  c.bootstrap();
  c.upsertList({ id: "L1", displayName: "Groceries", wellknownListName: "none" } as never);
  c.upsertTask({ id: "T1", title: "milk", status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" } as never, "L1");
  c.replaceAttachments("T1", "L1", [
    { id: "A1", name: "receipt.pdf", size: BYTES.byteLength, contentType: "application/pdf", "@odata.type": "#microsoft.graph.taskFileAttachment" },
  ] as never);
  const blobs = memoryBlobs();
  const env = { ...(opts.blobs === false ? {} : { BLOBS: blobs.store }) };
  const sidOf = (graphId: string) =>
    sql.exec<{ sid: string }>("SELECT sid FROM entity_map WHERE kind = 'attachment' AND graph_id = ?", graphId).one().sid;
  return { c, sql, env, blobs, sidOf };
}

const A1 = { list_id: "L1", task_id: "T1", attachment_id: "A1" };

describe("IndexCore.attachmentBlobRef", () => {
  it("names a mirrored file attachment's sid and metadata", () => {
    const { c, sidOf } = setup();
    expect(c.attachmentBlobRef("A1")).toEqual({
      sid: sidOf("A1"), name: "receipt.pdf", size: BYTES.byteLength, content_type: "application/pdf",
    });
  });

  it("is null for an attachment the mirror doesn't have", () => {
    expect(setup().c.attachmentBlobRef("nope")).toBeNull();
  });

  it("is null for a reference attachment, which has no bytes", () => {
    const { c } = setup();
    c.replaceAttachments("T1", "L1", [
      { id: "R1", name: "link", "@odata.type": "#microsoft.graph.taskReferenceAttachment" },
    ] as never);
    expect(c.attachmentBlobRef("R1")).toBeNull();
  });

  it("is null when the attachment's list is excluded", () => {
    const { c, sql } = setup();
    sql.exec("UPDATE lists SET sync = 'excluded' WHERE list_id = 'L1'");
    expect(c.attachmentBlobRef("A1")).toBeNull();
  });
});

describe("readAttachment", () => {
  it("on a miss, fetches from Graph and stores a copy under the sid", async () => {
    const { c, env, blobs, sidOf } = setup();
    let graphCalls = 0;
    const r = await readAttachment(env, c as never, A1, async () => (graphCalls++, BYTES));
    expect(r).toEqual({ bytes: BYTES, source: "graph" });
    expect(graphCalls).toBe(1);
    const stored = blobs.objects.get(attachmentBlobKey(sidOf("A1")));
    expect(stored?.bytes).toEqual(BYTES);
    expect(stored?.type).toBe("application/pdf");
  });

  it("on a hit, serves the stored copy without asking Graph", async () => {
    const { c, env, blobs, sidOf } = setup();
    blobs.objects.set(attachmentBlobKey(sidOf("A1")), { bytes: BYTES, uploaded: new Date(0) });
    const r = await readAttachment(env, c as never, A1, async () => {
      throw new Error("Graph should not be called");
    });
    expect(r?.source).toBe("cache");
    expect(r?.bytes).toEqual(BYTES);
  });

  it("goes to Graph and stores nothing for an attachment the mirror doesn't know", async () => {
    const { c, env, blobs } = setup();
    const r = await readAttachment(env, c as never, { ...A1, attachment_id: "A2" }, async () => BYTES);
    expect(r?.source).toBe("graph");
    expect(blobs.objects.size).toBe(0);
  });

  it("goes to Graph without a blob store", async () => {
    const { c, env } = setup({ blobs: false });
    expect((await readAttachment(env, c as never, A1, async () => BYTES))?.source).toBe("graph");
  });

  it("returns null when Graph has no bytes, and stores nothing", async () => {
    const { c, env, blobs } = setup();
    expect(await readAttachment(env, c as never, A1, async () => null)).toBeNull();
    expect(blobs.objects.size).toBe(0);
  });

  it("still serves Graph's bytes when the store fails", async () => {
    const { c, env } = setup();
    const broken = { ...env.BLOBS!, get: async () => { throw new Error("r2 down"); }, put: async () => { throw new Error("r2 down"); } };
    const r = await readAttachment({ BLOBS: broken }, c as never, A1, async () => BYTES);
    expect(r).toEqual({ bytes: BYTES, source: "graph" });
  });
});

describe("keepAttachment", () => {
  it("records a new attachment in the mirror and stores its bytes under the new sid", async () => {
    const { c, env, blobs, sidOf } = setup();
    await keepAttachment(env, c as never, { list_id: "L1", task_id: "T1", attachment_id: "A9", name: "new.txt", content_type: "text/plain" }, BYTES);
    const sid = sidOf("A9");
    expect(c.attachmentBlobRef("A9")).toMatchObject({ sid, name: "new.txt", size: BYTES.byteLength });
    expect(blobs.objects.get(attachmentBlobKey(sid))?.bytes).toEqual(BYTES);
  });

  it("stores nothing in an excluded list", async () => {
    const { c, sql, env, blobs } = setup();
    sql.exec("UPDATE lists SET sync = 'excluded' WHERE list_id = 'L1'");
    await keepAttachment(env, c as never, { list_id: "L1", task_id: "T1", attachment_id: "A9", name: "new.txt", content_type: "text/plain" }, BYTES);
    expect(blobs.objects.size).toBe(0);
  });

  it("never throws when the store fails", async () => {
    const { c, env } = setup();
    const broken = { ...env.BLOBS!, put: async () => { throw new Error("r2 down"); } };
    await expect(
      keepAttachment({ BLOBS: broken }, c as never, { list_id: "L1", task_id: "T1", attachment_id: "A9", name: "n", content_type: "text/plain" }, BYTES),
    ).resolves.toBeUndefined();
  });
});

describe("sync_status attachment totals", () => {
  it("counts mirrored file attachments, their bytes, and tasks whose attachments aren't scanned yet", async () => {
    const { c, sql } = setup();
    c.replaceAttachments("T1", "L1", [
      { id: "A1", name: "a.pdf", size: 100, contentType: "application/pdf", "@odata.type": "#microsoft.graph.taskFileAttachment" },
      { id: "A2", name: "b.png", size: 50, contentType: "image/png", "@odata.type": "#microsoft.graph.taskFileAttachment" },
      { id: "R1", name: "link", "@odata.type": "#microsoft.graph.taskReferenceAttachment" },
    ] as never);
    c.upsertTask({ id: "T2", title: "new", status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" } as never, "L1");
    sql.exec("UPDATE tasks SET checklist_synced_at = 1 WHERE task_id = 'T1'");
    sql.exec("UPDATE tasks SET checklist_synced_at = NULL WHERE task_id = 'T2'");
    const s = await c.syncStatus();
    expect(s.attachments).toEqual({ files: 2, bytes: 150, tasks_unscanned: 1 });
  });
});
