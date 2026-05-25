import { log } from "../log";
import { loadTokens } from "../auth/microsoft";
import { loadAttachmentConfig } from "../config/loader";
import { GraphClient, GraphError, type TokenProvider } from "../graph/client";
import { OWNER_DO_NAME } from "../cache/sql";
import type { TodoIndex } from "../cache/index-do";
import { resolveContentType } from "./sniff";
import {
  attachFile,
  getAttachmentBytes,
  listExistingFileAttachments,
  sha256Hex,
  PER_FILE_MAX_BYTES,
  type ExistingAttachment,
} from "./graph-upload";
import { renderUploadPage } from "./page";
import {
  DEFAULT_MAX_FILES,
  consumeUploadCapability,
  lookupUploadCapability,
  type UploadCapabilityScope,
} from "./tokens";

// Public (non-OAuth) binary upload endpoint. handleUpload returns a Response for
// /upload (GET serves the page, POST attaches the file(s) to the scoped task) or
// null for any other path so the caller's normal routing continues.
//
// Every POST must present a valid single-use signed link token (?t= / form `t`).
// There is no generic/bearer mode: a link is always scoped to one todo task.

// Cap the total bytes buffered for one POST. Each file is also capped at
// PER_FILE_MAX_BYTES (Graph's 25 MiB ceiling); this bounds a multi-file batch so
// the Worker doesn't buffer an unreasonable amount in memory.
const TOTAL_BATCH_MAX_BYTES = 60 * 1024 * 1024;

// Above this *raw uploaded* size, exact-content dedup would mean downloading the
// whole existing attachment to hash it — impractical. Larger uploads fall back to
// name matching (Graph rejects duplicate names on the upload session anyway).
const DEDUP_CONTENT_MAX_BYTES = 6 * 1024 * 1024;

// When content-hashing a small upload, skip existing candidates whose Graph
// `size` exceeds this — they're too large to be a match and not worth fetching.
// NOTE: Graph's attachment `size` is the Exchange *storage* size (base64/MIME
// overhead included), which is LARGER than the raw byte length and therefore
// can't be compared directly to an uploaded file's byte length. A raw upload of
// up to DEDUP_CONTENT_MAX_BYTES stores at roughly ≤ 1.4× that, so this cap keeps
// real matches in range while bounding downloads.
const DEDUP_FETCH_STORAGE_CAP = 9 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function ownerIndex(env: Env): DurableObjectStub<TodoIndex> {
  return env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName(OWNER_DO_NAME));
}

// Strip path components and control characters from a browser-supplied filename.
function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  let clean = "";
  for (const ch of base) {
    if (ch.charCodeAt(0) >= 0x20) clean += ch;
  }
  clean = clean.trim();
  return clean.slice(0, 255) || "upload";
}

function statusForReason(reason: string): number {
  switch (reason) {
    case "too_large":
    case "too_large_batch":
      return 413;
    case "unsupported_content_type":
      return 415;
    case "link_invalid":
    case "link_expired":
    case "unauthorized":
      return 401;
    case "not_authenticated":
      return 503;
    default:
      return 400;
  }
}

// Map a thrown GraphError to a typed reason for the upload response.
function reasonForGraphError(e: GraphError): { reason: string; detail: string } {
  const detail = e.detail ?? "";
  if (e.status === 404 || (e.status === 400 && detail.includes("ErrorInvalidIdMalformed"))) {
    return { reason: "task_not_found", detail };
  }
  return { reason: `graph_${e.status}`, detail };
}

async function renderGetPage(env: Env, url: URL): Promise<string> {
  const linkToken = url.searchParams.get("t");
  if (!linkToken) return renderUploadPage({ disabled: true });

  const verified = await lookupUploadCapability(env, linkToken);
  if (!verified.ok) return renderUploadPage({ linkError: verified.reason });

  const scope = verified.value;
  const multiple = scope.max_files !== undefined;
  return renderUploadPage({
    taskTitle: scope.task_title,
    listName: scope.list_name,
    filename: scope.filename,
    multiple,
    maxFiles: scope.max_files,
  });
}

export async function handleUpload(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/upload") return null;

  if (req.method === "GET") return html(await renderGetPage(env, url));
  if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);

  // CSRF hardening: only accept multipart form posts (browser fetch with
  // FormData), never urlencoded form submissions, and never cookie-based auth.
  const contentType = req.headers.get("content-type")?.trimStart().toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return json({ ok: false, reason: "unsupported_content_type" }, 415);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ ok: false, reason: "invalid_form" }, 400);
  }

  // ── Authenticate (single-use signed link only) ─────────────────────────
  const linkToken = (form.get("t") as string | null) ?? url.searchParams.get("t");
  if (!linkToken) {
    log.info("upload_auth_failed", { reason: "missing_token" });
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  const verified = await lookupUploadCapability(env, linkToken);
  if (!verified.ok) {
    log.info("upload_auth_failed", { reason: verified.reason });
    return json({ ok: false, reason: verified.reason }, statusForReason(verified.reason));
  }
  const scope: UploadCapabilityScope = verified.value;

  // Owner must be signed in for us to call Graph on their behalf.
  if (!(await loadTokens(env))) {
    return json({ ok: false, reason: "not_authenticated" }, 503);
  }

  // ── Validate file count / sizes ────────────────────────────────────────
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) return json({ ok: false, reason: "no_file" }, 400);

  const singleFile = scope.max_files === undefined; // filename-baked link
  const maxFiles = singleFile ? 1 : scope.max_files ?? DEFAULT_MAX_FILES;
  if (files.length > maxFiles) {
    return json({ ok: false, reason: "too_many_files", max: maxFiles }, 400);
  }

  let totalBytes = 0;
  for (const f of files) {
    if (f.size === 0) return json({ ok: false, reason: "empty_file", name: f.name }, 400);
    if (f.size > PER_FILE_MAX_BYTES) {
      return json(
        { ok: false, reason: "too_large", name: f.name, size: f.size, max: PER_FILE_MAX_BYTES },
        413,
      );
    }
    totalBytes += f.size;
  }
  if (totalBytes > TOTAL_BATCH_MAX_BYTES) {
    return json({ ok: false, reason: "too_large_batch", size: totalBytes, max: TOTAL_BATCH_MAX_BYTES }, 413);
  }

  // Burn the link now: a single-use link gets exactly one POST attempt,
  // whatever the outcome. This prevents replay and avoids re-attaching files
  // that already landed if a later file in the batch fails.
  await consumeUploadCapability(env, linkToken);

  // ── Attach each file to the scoped task ────────────────────────────────
  const stub = ownerIndex(env);
  const tp: TokenProvider = {
    getAccessToken: () => stub.getAccessToken(),
    forceRefresh: () => stub.forceRefresh(),
  };
  const graph = new GraphClient(tp);
  const maxInlineBytes = (await loadAttachmentConfig(env)).max_inline_bytes;

  let accessToken: string;
  try {
    accessToken = await stub.getAccessToken();
  } catch {
    return json({ ok: false, reason: "not_authenticated" }, 503);
  }

  // Existing attachments on the task, for exact-duplicate detection. Best-effort:
  // if the list can't be read we proceed without dedup (a real task error will
  // resurface per-file on attach).
  let existing: ExistingAttachment[] = [];
  try {
    existing = await listExistingFileAttachments(graph, scope.list_id, scope.task_id);
  } catch (e) {
    log.warn("upload_dedup_list_failed", { task_id: scope.task_id, error: String(e) });
  }
  log.info("upload_dedup_existing", { task_id: scope.task_id, count: existing.length });
  const existingHashes = new Map<string, string>(); // attachment id -> sha256 (memoized)
  const batchHashes = new Map<string, string>(); // sha256 -> attachment id (already attached this batch)

  type Outcome =
    | { ok: true; status: "attached"; attachment_id: string; name: string; size: number; content_type: string; via: "inline" | "session" }
    | { ok: true; status: "duplicate"; name: string; size: number; attachment_id: string | null }
    | { ok: false; status: "error"; name: string; reason: string; detail?: string };

  const outcomes: Outcome[] = [];
  let attachedCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;

  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = scope.filename ? sanitizeName(scope.filename) : sanitizeName(file.name);
    const ct = resolveContentType(name, bytes, file.type || scope.content_type);
    const hash = await sha256Hex(bytes);

    // Exact duplicate? First an identical file earlier in this same batch, then
    // any same-size attachment already on the task (only same-size candidates can
    // match byte-for-byte, so we fetch+hash just those).
    log.info("upload_dedup_file", {
      task_id: scope.task_id,
      name,
      size: bytes.byteLength,
      hash: hash.slice(0, 16),
      existing_count: existing.length,
    });

    // Compare by content hash, NOT by Graph's `size` (which is the Exchange
    // storage size, not the raw byte length, so it never equals an uploaded
    // file's byte length). The decoded contentBytes of an existing attachment is
    // the original raw file, so its SHA-256 matches the upload when identical.
    const isLarge = bytes.byteLength > DEDUP_CONTENT_MAX_BYTES;
    let dupId: string | null = batchHashes.get(hash) ?? null;
    if (dupId === null) {
      for (const att of existing) {
        if (isLarge) {
          // Too big to content-hash (would download the whole existing file);
          // fall back to name match.
          if (att.name && att.name === name) {
            dupId = att.id;
            break;
          }
          continue;
        }
        // Bound downloads: a candidate this much larger can't match a small upload.
        if (att.size > DEDUP_FETCH_STORAGE_CAP) continue;
        let h = existingHashes.get(att.id);
        if (h === undefined) {
          try {
            const exBytes = await getAttachmentBytes(graph, scope.list_id, scope.task_id, att.id);
            if (!exBytes) {
              log.warn("upload_dedup_no_bytes", { task_id: scope.task_id, attachment_id: att.id });
              continue;
            }
            h = await sha256Hex(exBytes);
            existingHashes.set(att.id, h);
          } catch (e) {
            log.warn("upload_dedup_fetch_failed", {
              task_id: scope.task_id,
              attachment_id: att.id,
              error: String(e),
            });
            continue;
          }
        }
        if (h === hash) {
          dupId = att.id;
          break;
        }
      }
    }
    if (dupId !== null) {
      duplicateCount++;
      outcomes.push({ ok: true, status: "duplicate", name, size: bytes.byteLength, attachment_id: dupId });
      log.info("upload_duplicate_skipped", { task_id: scope.task_id, name, attachment_id: dupId });
      continue;
    }

    try {
      const r = await attachFile(graph, accessToken, {
        listId: scope.list_id,
        taskId: scope.task_id,
        name,
        bytes,
        contentType: ct,
        maxInlineBytes,
      });
      attachedCount++;
      if (r.attachment_id) batchHashes.set(hash, r.attachment_id);
      outcomes.push({
        ok: true,
        status: "attached",
        attachment_id: r.attachment_id,
        name: r.name,
        size: r.size,
        content_type: r.content_type,
        via: r.via,
      });
    } catch (e) {
      failedCount++;
      if (e instanceof GraphError) {
        const { reason, detail } = reasonForGraphError(e);
        outcomes.push({ ok: false, status: "error", name, reason, detail });
        log.warn("upload_attach_failed", { task_id: scope.task_id, name, reason });
      } else {
        outcomes.push({ ok: false, status: "error", name, reason: "unexpected_error" });
        log.error("upload_attach_unexpected", { task_id: scope.task_id, name, error: String(e) });
      }
    }
  }

  // Best-effort: keep the DO index's has_attachments flag honest. Set it
  // whenever the task ends up with attachments — newly attached, or confirmed
  // present via a duplicate match. A failure here never fails the upload (Graph
  // already has the bytes; the next delta sync reconciles).
  if (attachedCount > 0 || duplicateCount > 0) {
    await stub
      .setTaskFlags(scope.task_id, { has_attachments: true })
      .catch((e) => log.warn("upload_index_flag_failed", { task_id: scope.task_id, error: String(e) }));
  }

  const allOk = failedCount === 0;
  log.info("upload_done", {
    task_id: scope.task_id,
    attached: attachedCount,
    duplicates: duplicateCount,
    failed: failedCount,
  });
  return json(
    {
      ok: allOk,
      list_id: scope.list_id,
      task_id: scope.task_id,
      files: outcomes,
    },
    allOk ? 200 : 502,
  );
}
