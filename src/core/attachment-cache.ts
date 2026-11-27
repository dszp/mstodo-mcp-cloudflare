// The blob store's copies of task attachments, for the Claude connector's
// paths: get_attachment, the /download link and upload links. The app's GET /api/v1/attachments/{sid} keeps its own streaming read
// (src/core/api/attachments.ts); both store under the same key, so a copy
// made by either serves the other.
//
// An attachment can't be edited, so a sid always names the same bytes and a
// stored copy never goes stale. The store is a cache, never the source of
// truth: every failure falls back to Graph, and nothing here throws because
// the store is down.
import { attachmentBlobKey } from "./blobs";
import { log } from "./log";
import type { BlobStore, IndexBackend } from "./ports";

type CacheEnv = { BLOBS?: BlobStore };
type CacheIndex = Pick<IndexBackend, "attachmentBlobRef" | "putAttachment">;

export interface AttachmentRef {
  list_id: string;
  task_id: string;
  attachment_id: string;
}

// An attachment's bytes: the stored copy when there is one, else Graph's,
// which are then stored for next time. Only an attachment the mirror knows
// is stored, since the copy is keyed by its sid and the sweep deletes copies
// with no sid. null: Graph has no bytes for it.
export async function readAttachment(
  env: CacheEnv,
  index: CacheIndex,
  ref: AttachmentRef,
  fromGraph: () => Promise<Uint8Array | null>,
): Promise<{ bytes: Uint8Array; source: "cache" | "graph" } | null> {
  const blobs = env.BLOBS;
  // The copy is keyed by attachment alone, so a request naming another task
  // goes to Graph, which answers for that task.
  const found = blobs ? await index.attachmentBlobRef(ref.attachment_id) : null;
  const known = found && found.task_id === ref.task_id ? found : null;
  if (blobs && known) {
    const stored = await blobs.get(attachmentBlobKey(known.sid)).catch((e: unknown) => {
      log.warn("blob_get_failed", { attachment: known.sid, error: String(e) });
      return null;
    });
    if (stored) return { bytes: new Uint8Array(await new Response(stored.body).arrayBuffer()), source: "cache" };
  }
  const bytes = await fromGraph();
  if (!bytes) return null;
  if (blobs && known) await putCopy(blobs, known.sid, bytes, known.content_type);
  return { bytes, source: "graph" };
}

// After the connector attaches a file through Graph: records it in the mirror
// at once (the sub-resource scan would find it later) and stores the bytes it
// already holds, so the first read never goes back to Graph.
export async function keepAttachment(
  env: CacheEnv,
  index: CacheIndex,
  att: AttachmentRef & { name: string; content_type: string },
  bytes: Uint8Array,
): Promise<void> {
  try {
    await index.putAttachment(att.task_id, att.list_id, {
      id: att.attachment_id, name: att.name, size: bytes.byteLength, content_type: att.content_type,
    });
    if (!env.BLOBS) return;
    const known = await index.attachmentBlobRef(att.attachment_id);
    if (known) await putCopy(env.BLOBS, known.sid, bytes, att.content_type);
  } catch (e) {
    log.warn("attachment_keep_failed", { attachment_id: att.attachment_id, error: String(e) });
  }
}

async function putCopy(blobs: BlobStore, sid: string, bytes: Uint8Array, contentType: string | null): Promise<void> {
  await blobs
    .put(attachmentBlobKey(sid), bytes, contentType ? { httpMetadata: { contentType } } : undefined)
    .catch((e: unknown) => log.warn("blob_put_failed", { attachment: sid, error: String(e) }));
}
