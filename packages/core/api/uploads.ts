// The binary /api/v1 routes (docs/SYNC-API.md sections 4.8 and 5.6): an app
// upload of a task attachment, and theme images in and out of the blob store.
// They sit beside the mutation batch rather than in it because the body is the
// file itself.
import { attachmentBlobKey, THEME_IMAGE_ID, themeImageBlobKey, themeImageId } from "../blobs";
import { loadAttachmentConfig } from "../config/loader";
import { GraphClient, GraphError } from "../graph/client";
import { log } from "../log";
import { WriteBusyError, WriteLease } from "../ops/write-lease";
import { ownerIndex } from "../owner-index";
import type { AppEnv, IndexBackend } from "../ports";
import { normalizeSid, MUTATION_LEASE_MS } from "../sync/mutations";
import type { Props } from "../types";
import {
  attachFile,
  getAttachmentBytes,
  listExistingFileAttachments,
  PER_FILE_MAX_BYTES,
  sha256Hex,
} from "../upload/graph-upload";
import { sanitizeName } from "../upload/handler";
import { resolveContentType, sniffMime } from "../upload/sniff";
import { graphFailure } from "./attachments";
import { readBytes, TOO_LARGE } from "./mutations";
import { json } from "./respond";

const SID_RE = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bad = (detail: string) => json({ error: "bad_request", detail }, 400);

// ── Attachment upload (section 5.6) ─────────────────────────────────────────

export async function uploadAttachment(req: Request, env: AppEnv, props: Partial<Props> | undefined): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const taskSid = normalizeSid(q.get("task_id") ?? "");
  const sid = normalizeSid(q.get("sid") ?? "");
  if (!SID_RE.test(taskSid)) return bad("task_id");
  if (!SID_RE.test(sid)) return bad("sid");
  const rawName = q.get("name") ?? "";
  if (!rawName.trim()) return bad("name");
  const name = sanitizeName(rawName);

  const bytes = await readBytes(req, PER_FILE_MAX_BYTES);
  if (bytes === TOO_LARGE) return json({ error: "too_large", max: PER_FILE_MAX_BYTES }, 413);
  if (bytes === null || bytes.byteLength === 0) return bad("body");
  const contentType = resolveContentType(name, bytes, req.headers.get("content-type"));

  const index = ownerIndex(env);
  const resolved = await index.resolveSids([
    { kind: "task", sid: taskSid },
    { kind: "attachment", sid },
  ]);
  const task = resolved[`task:${taskSid}`];
  if (task?.excluded) return json({ error: "list_excluded" }, 409);
  if (!task?.graph_id || !task.live) return json({ error: "unknown_task" }, 404);
  const listId = (await index.findListForTask(task.graph_id))?.list_id;
  if (!listId) return json({ error: "unknown_task" }, 404);

  // The upload is a create keyed by the app's sid, so it shares the mutation
  // log's idempotency (section 5.4) under an id of its own.
  const mutationId = `attachment.upload:${sid}`;
  const principal = props?.principal ? `${props.principal.iss}|${props.principal.sub}` : (props?.user ?? "unknown");
  const begun = await index.mutationBegin(mutationId, principal, Date.now(), MUTATION_LEASE_MS);
  if (begun.state === "done") return repeated(begun.result, sid, index);
  if (begun.state === "leased") return json({ error: "in_progress", retry: true }, 409);

  const self = resolved[`attachment:${sid}`];
  if (self?.graph_id && (self.live || begun.prior_at_ms !== undefined)) {
    await index.mutationFinish(mutationId, { status: "applied", sid }, []);
    return json({ status: "applied", sid, cursor: await index.syncCursor() });
  }
  if (self?.graph_id) {
    await index.mutationAbandon(mutationId);
    return json({ error: "sid_in_use" }, 409);
  }

  const graph = new GraphClient({
    getAccessToken: () => index.getAccessToken(),
    forceRefresh: () => index.refreshToken(),
    reportClaimsChallenge: (claims: string) => index.markReauthRequired("claims_challenge", claims),
  });
  let outcome: "attached" | "already" | "sid_in_use";
  try {
    // The attach and the sid's reservation share the write lease, so an
    // attempt that took over this mutation after its lease ran out (a long
    // upload) waits for the first, then sees the sid it reserved.
    outcome = await new WriteLease(index).hold(async () => {
      let attachmentId: string | null = null;
      if (begun.prior_at_ms !== undefined) {
        const now = (await index.resolveSids([{ kind: "attachment", sid }]))[`attachment:${sid}`];
        if (now?.graph_id) return "already";
        const found = await findEarlierUpload(graph, index, listId, task.graph_id!, name, bytes, begun.prior_at_ms);
        if (found === "ambiguous") throw new Ambiguous();
        attachmentId = found;
      }
      if (attachmentId === null) {
        const maxInlineBytes = (await loadAttachmentConfig(env)).max_inline_bytes;
        const r = await attachFile(graph, await index.getAccessToken(), {
          listId, taskId: task.graph_id!, name, bytes, contentType, maxInlineBytes,
        });
        attachmentId = r.attachment_id;
      }
      if (!(await index.reserveSid("attachment", sid, attachmentId)) && !(await index.adoptSid("attachment", sid, attachmentId))) {
        return "sid_in_use";
      }
      await index.putAttachment(task.graph_id!, listId, { id: attachmentId, name, size: bytes.byteLength, content_type: contentType });
      return "attached";
    });
  } catch (e) {
    if (e instanceof Ambiguous) {
      await index.mutationFinish(mutationId, { status: "rejected", error: "ambiguous_create" }, []);
      return json({ error: "ambiguous_create" }, 409);
    }
    if (e instanceof WriteBusyError) {
      // Nothing was written by this attempt; an earlier one's mark that it
      // may have written is kept for the next retry.
      if (begun.prior_at_ms !== undefined) await index.mutationRelease(mutationId);
      else await index.mutationAbandon(mutationId);
      return json({ error: "write_busy", retry: true }, 503);
    }
    // A 5xx or a dropped connection may have attached the file: the retry
    // looks for it before attaching again. A retry that fails any other way
    // keeps the earlier attempt's mark, which may still have attached it.
    const maybeWritten = (e instanceof GraphError && e.status >= 500) || e instanceof TypeError;
    if (maybeWritten || begun.prior_at_ms !== undefined) await index.mutationRelease(mutationId);
    else await index.mutationAbandon(mutationId);
    return graphFailure(e, sid, "attachment_upload");
  }

  if (outcome === "sid_in_use") {
    await index.mutationFinish(mutationId, { status: "rejected", error: "sid_in_use" }, []);
    return json({ error: "sid_in_use" }, 409);
  }
  if (outcome === "attached" && env.BLOBS) {
    await env.BLOBS.put(attachmentBlobKey(sid), bytes, { httpMetadata: { contentType } }).catch((e: unknown) =>
      log.warn("blob_put_failed", { attachment: sid, error: String(e) }),
    );
  }
  await index.mutationFinish(mutationId, { status: "applied", sid }, []);
  return json({ status: "applied", sid, cursor: await index.syncCursor() });
}

// A repeat of an upload that already finished: its stored result, with the
// status the first answer had.
async function repeated(result: unknown, sid: string, index: IndexBackend): Promise<Response> {
  const r = (result ?? {}) as { status?: string; error?: string };
  if (r.status === "rejected" && r.error) return json({ error: r.error }, 409);
  return json({ status: "duplicate", sid, cursor: await index.syncCursor() });
}

class Ambiguous extends Error {}

// Graph's clock against this server's, for an attachment's lastModifiedDateTime.
// Generous: too small and a retry misses its own upload and attaches twice;
// too large only admits identical bytes under the same name, which are still
// byte-compared and must be unknown to the mirror before the first attempt.
const CLOCK_SKEW_MS = 10 * 60_000;

// A retry after a failure that may have reached Graph: the attachment the
// earlier attempt made, if Graph stored it. A candidate has this name and
// these exact bytes, no other create's sid, and is no older than the earlier
// attempt: the mirror hadn't seen it before that attempt began, and Graph
// doesn't date it before then. A file already on the task is never adopted,
// even an identical one. null: none, so attach.
async function findEarlierUpload(
  graph: GraphClient,
  index: IndexBackend,
  listId: string,
  taskId: string,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  priorAtMs: number,
): Promise<string | null | "ambiguous"> {
  const named = (await listExistingFileAttachments(graph, listId, taskId)).filter((a) => a.name === name);
  if (named.length === 0) return null;
  const known = await index.createCandidates("attachment", named.map((a) => a.id));
  const fresh = named.filter((a) => {
    const k = known[a.id];
    if (k && (k.app_owned || k.first_seen_ms < priorAtMs)) return false;
    const modified = a.modified ? Date.parse(a.modified) : NaN;
    return Number.isNaN(modified) || modified >= priorAtMs - CLOCK_SKEW_MS;
  });
  if (fresh.length === 0) return null;
  const want = await sha256Hex(bytes);
  const same: string[] = [];
  for (const a of fresh) {
    const b = await getAttachmentBytes(graph, listId, taskId, a.id);
    if (b && (await sha256Hex(b)) === want) same.push(a.id);
  }
  if (same.length === 1) return same[0];
  return same.length === 0 ? null : "ambiguous";
}

// ── Theme images (section 4.8) ──────────────────────────────────────────────

export const THEME_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const THEME_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/heic"]);
const MAX_DIMENSION = 20_000;

// HEIC is an ISO-BMFF file: a `ftyp` box first, with an image brand.
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);
function isHeic(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  const ascii = (from: number) => String.fromCharCode(b[from], b[from + 1], b[from + 2], b[from + 3]);
  return ascii(4) === "ftyp" && HEIC_BRANDS.has(ascii(8));
}

function bytesAre(type: string, b: Uint8Array): boolean {
  return type === "image/heic" ? isHeic(b) : sniffMime(b) === type;
}

function dimension(raw: string | null): number | null {
  if (raw === null || !/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_DIMENSION ? n : null;
}

export async function uploadThemeImage(req: Request, env: AppEnv): Promise<Response> {
  if (!env.BLOBS) return json({ error: "no_blob_store" }, 501);
  const q = new URL(req.url).searchParams;
  const width = dimension(q.get("width"));
  const height = dimension(q.get("height"));
  if (width === null || height === null) return json({ error: "bad_dimensions" }, 400);
  const rawBrightness = q.get("brightness");
  let brightness: number | null = null;
  if (rawBrightness !== null) {
    // Any plain decimal, in exponent form too: Swift writes a Double with
    // all its digits (0.4235294117647059), and a small one as 1e-05.
    brightness = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(rawBrightness) ? Number(rawBrightness) : NaN;
    if (!(brightness >= 0 && brightness <= 1)) return json({ error: "bad_brightness" }, 400);
  }
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!THEME_IMAGE_TYPES.has(type)) return json({ error: "unsupported_type" }, 415);

  const bytes = await readBytes(req, THEME_IMAGE_MAX_BYTES);
  if (bytes === TOO_LARGE) return json({ error: "too_large", max: THEME_IMAGE_MAX_BYTES }, 413);
  if (bytes === null || !bytesAre(type, bytes)) return json({ error: "unsupported_type" }, 415);

  const id = await themeImageId(bytes);
  const index = ownerIndex(env);
  // Bytes first, then the row: a row never names missing bytes, and bytes
  // left without a row (a failure between) are swept.
  await env.BLOBS.put(themeImageBlobKey(id), bytes, { httpMetadata: { contentType: type } });
  const r = await index.putThemeImage({ image_id: id, content_type: type, size: bytes.byteLength, width, height, brightness });
  return json(r.image, r.created ? 201 : 200);
}

export async function themeImageBytes(rawId: string, req: Request, env: AppEnv): Promise<Response> {
  if (!env.BLOBS) return json({ error: "no_blob_store" }, 501);
  const id = rawId.toLowerCase();
  if (!THEME_IMAGE_ID.test(id)) return json({ error: "not_found" }, 404);
  const image = await ownerIndex(env).themeImage(id);
  if (!image) return json({ error: "not_found" }, 404);
  const headers: Record<string, string> = {
    "content-type": image.content_type,
    etag: `"${id}"`,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  };
  // The id is the content, so a cached copy is always current.
  if ((req.headers.get("if-none-match") ?? "").includes(`"${id}"`)) return new Response(null, { status: 304, headers });
  const obj = await env.BLOBS.get(themeImageBlobKey(id));
  if (!obj) return json({ error: "not_found" }, 404);
  return new Response(obj.body, { status: 200, headers: { ...headers, "content-length": String(obj.size) } });
}
