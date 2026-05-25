import { GraphClient, GraphError, assertGraphUrl } from "../graph/client";
import { AttachmentSchema, TaskFileAttachmentSchema, UploadSessionSchema } from "../graph/types";
import { log } from "../log";

// Forward an uploaded file to a Microsoft To Do task. Two Graph paths, chosen by
// size (see https://learn.microsoft.com/graph/todo-attachments):
//
//   - Inline (≤ 3072 KiB raw): a single POST to the task's /attachments with the
//     bytes base64-encoded inline. Reuses GraphClient.
//   - Upload session (larger, up to 25 MiB): POST /attachments/createUploadSession
//     to get an opaque graph.microsoft.com upload URL, then PUT sequential byte
//     ranges (< 4 MiB each) to `${uploadUrl}/content`. For To Do specifically the
//     upload URL is graph-hosted and each PUT DOES require the Bearer token
//     (unlike OneDrive's pre-authed off-host URLs). The final range PUT returns
//     201 Created with a Location header pointing at the new attachment.
//
// The bytes never touch the model: they arrive at /upload from the browser and
// are streamed on to Graph here within the same request.

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Graph's hard ceiling for a single To Do attachment. */
export const PER_FILE_MAX_BYTES = 25 * 1024 * 1024;

// Each upload-session PUT must be < 4 MiB; 3.75 MiB keeps a safe margin.
const CHUNK_BYTES = 3_932_160;

export interface UploadResult {
  attachment_id: string;
  name: string;
  size: number;
  content_type: string;
  via: "inline" | "session";
}

interface AttachArgs {
  listId: string;
  taskId: string;
  name: string;
  bytes: Uint8Array;
  contentType: string;
  /** Inline-vs-session cutover (config.max_inline_bytes; ≤ 3072 KiB). */
  maxInlineBytes: number;
}

function attachmentsUrl(listId: string, taskId: string): string {
  return `${GRAPH_BASE}/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(
    taskId,
  )}/attachments`;
}

function base64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** SHA-256 of the given bytes, hex-encoded. Used for exact-duplicate detection. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ExistingAttachment {
  id: string;
  name?: string;
  size: number;
}

/**
 * List the task's existing file attachments (metadata only — the collection
 * endpoint omits contentBytes). Reference attachments and any without a known
 * size are dropped: only sized file attachments can be exact-duplicate
 * candidates. Throws GraphError if the task can't be read.
 */
export async function listExistingFileAttachments(
  graph: GraphClient,
  listId: string,
  taskId: string,
): Promise<ExistingAttachment[]> {
  const result = await graph.getAllPages(attachmentsUrl(listId, taskId), AttachmentSchema);
  if (result.status !== 200) return [];
  const out: ExistingAttachment[] = [];
  for (const att of result.items) {
    if (att["@odata.type"] === "#microsoft.graph.taskFileAttachment" && typeof att.size === "number") {
      out.push({ id: att.id, name: att.name, size: att.size });
    }
  }
  return out;
}

/** Fetch one attachment's bytes (decoded from contentBytes), or null if absent. */
export async function getAttachmentBytes(
  graph: GraphClient,
  listId: string,
  taskId: string,
  attachmentId: string,
): Promise<Uint8Array | null> {
  const url = `${attachmentsUrl(listId, taskId)}/${encodeURIComponent(attachmentId)}`;
  const att = await graph.getJson(url, TaskFileAttachmentSchema);
  return att.contentBytes ? bytesFromBase64(att.contentBytes) : null;
}

async function inlineAttach(
  graph: GraphClient,
  args: AttachArgs,
): Promise<UploadResult> {
  const url = attachmentsUrl(args.listId, args.taskId);
  const body = {
    "@odata.type": "#microsoft.graph.taskFileAttachment",
    name: args.name,
    contentBytes: base64FromBytes(args.bytes),
    contentType: args.contentType,
  };
  const attachment = await graph.postJson(url, body, TaskFileAttachmentSchema);
  return {
    attachment_id: attachment.id,
    name: attachment.name ?? args.name,
    size: attachment.size ?? args.bytes.byteLength,
    content_type: attachment.contentType ?? args.contentType,
    via: "inline",
  };
}

// Parse the leading byte offset out of a nextExpectedRanges entry like
// "2097152" or "2097152-3483321". Returns null if unparseable.
function parseNextStart(ranges: string[] | undefined): number | null {
  if (!ranges || ranges.length === 0) return null;
  const start = Number.parseInt(ranges[0].split("-")[0], 10);
  return Number.isFinite(start) ? start : null;
}

function attachmentIdFromLocation(location: string | null): string {
  if (!location) return "";
  const path = location.split("?")[0].replace(/\/+$/, "");
  const seg = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

async function sessionAttach(
  graph: GraphClient,
  accessToken: string,
  args: AttachArgs,
): Promise<UploadResult> {
  const total = args.bytes.byteLength;
  const session = await graph.postJson(
    `${attachmentsUrl(args.listId, args.taskId)}/createUploadSession`,
    { attachmentInfo: { attachmentType: "file", name: args.name, size: total } },
    UploadSessionSchema,
  );

  // The upload URL is graph-hosted for To Do; pin the host before sending the
  // Bearer token with each chunk (defense-in-depth, mirrors GraphClient).
  assertGraphUrl(session.uploadUrl);
  const contentUrl = `${session.uploadUrl}/content`;

  let start = 0;
  let guard = 0;
  const maxIterations = Math.ceil(total / CHUNK_BYTES) + 2;
  while (start < total) {
    if (guard++ > maxIterations) {
      await cancelSession(session.uploadUrl, accessToken);
      throw new GraphError(0, "upload_session_stalled");
    }
    const end = Math.min(start + CHUNK_BYTES, total) - 1;
    const chunk = args.bytes.subarray(start, end + 1);
    const res = await fetch(contentUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-length": String(chunk.byteLength),
        "content-range": `bytes ${start}-${end}/${total}`,
        "content-type": "application/octet-stream",
      },
      body: chunk,
    });

    if (res.status === 201) {
      const id = attachmentIdFromLocation(res.headers.get("location"));
      return {
        attachment_id: id,
        name: args.name,
        size: total,
        content_type: args.contentType,
        via: "session",
      };
    }
    if (res.status === 200) {
      const json = (await res.json().catch(() => null)) as
        | { nextExpectedRanges?: string[]; NextExpectedRanges?: string[] }
        | null;
      const ranges = json?.nextExpectedRanges ?? json?.NextExpectedRanges;
      const next = parseNextStart(ranges);
      start = next !== null ? next : end + 1;
      continue;
    }
    // Anything else: release the session and surface a typed error.
    const detail = await res.text().catch(() => "");
    await cancelSession(session.uploadUrl, accessToken);
    throw new GraphError(res.status, `graph_${res.status}`, detail.slice(0, 500));
  }

  // Ran out of bytes without a 201 Created — Graph never finalized.
  await cancelSession(session.uploadUrl, accessToken);
  throw new GraphError(0, "upload_session_incomplete");
}

async function cancelSession(uploadUrl: string, accessToken: string): Promise<void> {
  try {
    await fetch(uploadUrl, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    log.warn("upload_session_cancel_failed", { error: String(e) });
  }
}

/**
 * Attach a file to a To Do task, choosing the inline or upload-session path by
 * size. Throws GraphError on a Graph failure (mapped by the caller). The caller
 * must enforce PER_FILE_MAX_BYTES before calling.
 */
export async function attachFile(
  graph: GraphClient,
  accessToken: string,
  args: AttachArgs,
): Promise<UploadResult> {
  if (args.bytes.byteLength <= args.maxInlineBytes) {
    return inlineAttach(graph, args);
  }
  return sessionAttach(graph, accessToken, args);
}
