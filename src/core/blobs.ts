// Blob store keys and the daily sweep (docs/SYNC-API.md sections 4.6, 4.8 and
// 4.9). One bucket per deployment: attachment copies under attachments/<sid>,
// theme images under theme-images/<id>.
import { log } from "./log";
import type { BlobStore, IndexBackend } from "./ports";

// A theme image's id: the first 32 hex digits of its bytes' SHA-256.
export const THEME_IMAGE_ID = /^[0-9a-f]{32}$/;
export const THEME_IMAGE_IDLE_MS = 30 * 86_400_000;

const ATTACHMENTS = "attachments/";
const THEME_IMAGES = "theme-images/";

export const attachmentBlobKey = (sid: string) => `${ATTACHMENTS}${sid}`;
export const themeImageBlobKey = (id: string) => `${THEME_IMAGES}${id}`;

export async function themeImageId(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

// An object uploaded within this window is never swept: its index row may
// not be written yet (an upload stores the bytes first).
const SWEEP_GRACE_MS = 3_600_000;

// Deletes theme images nothing has used for 30 days, then every object the
// index no longer knows: copies of attachments that left the mirror, and
// images whose row is gone (a delete whose byte removal failed, an owner
// switch). Returns how many objects it deleted.
export async function sweepBlobs(blobs: BlobStore, index: IndexBackend, nowMs = Date.now()): Promise<number> {
  let deleted = 0;
  const expired = await index.sweepThemeImages(nowMs, THEME_IMAGE_IDLE_MS);
  if (expired.length) {
    await blobs.delete(expired.map(themeImageBlobKey));
    deleted += expired.length;
  }
  for (const prefix of [ATTACHMENTS, THEME_IMAGES]) {
    let cursor: string | undefined;
    do {
      const page = await blobs.list({ prefix, cursor, limit: 500 });
      const ids = page.objects
        .filter((o) => nowMs - o.uploaded.getTime() > SWEEP_GRACE_MS)
        .map((o) => o.key.slice(prefix.length));
      if (ids.length) {
        const live = await index.liveBlobIds(prefix === THEME_IMAGES ? ids : [], prefix === ATTACHMENTS ? ids : []);
        const keep = new Set(prefix === THEME_IMAGES ? live.theme_images : live.attachments);
        const gone = ids.filter((id) => !keep.has(id)).map((id) => prefix + id);
        if (gone.length) {
          await blobs.delete(gone);
          deleted += gone.length;
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  if (deleted) log.info("blob_sweep", { deleted });
  return deleted;
}
