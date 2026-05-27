import { log } from "../log";
import { loadTokens } from "../auth/microsoft";
import { GraphClient, GraphError, type TokenProvider } from "../graph/client";
import { getAttachmentBytes } from "./graph-upload";
import { json, ownerIndex, reasonForGraphError, sanitizeName, statusForReason } from "./handler";
import {
  consumeDownloadCapability,
  downloadLinksEnabled,
  lookupDownloadCapability,
} from "./tokens";

// Public (non-OAuth) binary download endpoint — the inverse of /upload (ROADMAP
// §9). handleDownload returns a Response for /download or null for any other path
// so the caller's normal routing continues.
//
// A GET with a valid single-use capability token (?t=) serves exactly one
// attachment's bytes and burns the token. The metadata (filename, content type)
// was baked into the capability at mint time, so /download makes a single Graph
// call (the bytes) and trusts no request headers. There is no bearer mode: a link
// is always scoped to one attachment on one task.

// Build a Content-Disposition that survives non-ASCII filenames: a sanitized
// ASCII fallback in `filename=` plus an RFC 5987 `filename*` with the real name.
function contentDisposition(name: string): string {
  const safe = sanitizeName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function handleDownload(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/download") return null;

  // Feature gate: deployments that don't need the server-to-server pull can turn
  // the whole surface off (defaults on).
  if (!downloadLinksEnabled(env)) {
    return json({ ok: false, reason: "download_disabled" }, 404);
  }

  // Method-aware: only GET may burn a link. A stray HEAD/POST must not consume it.
  if (req.method !== "GET") {
    return json({ ok: false, reason: "method_not_allowed" }, 405);
  }

  const linkToken = url.searchParams.get("t");
  const verified = await lookupDownloadCapability(env, linkToken ?? "");
  if (!verified.ok) {
    log.info("download_link_invalid", { reason: verified.reason });
    return json({ ok: false, reason: verified.reason }, statusForReason(verified.reason));
  }
  const scope = verified.value;

  // Owner must be signed in for us to call Graph on their behalf. Check BEFORE
  // burning: a server-state issue must not consume the requester's one-shot link.
  if (!(await loadTokens(env))) {
    return json({ ok: false, reason: "not_authenticated" }, 503);
  }

  // Burn now — before the Graph fetch — so any reachable GET is single-use
  // whatever the outcome. Single-use against an honest consumer; not transactional
  // (two concurrent GETs could both pass lookup before either delete lands, same
  // as /upload). Never log the token.
  await consumeDownloadCapability(env, linkToken ?? "");
  log.info("download_burned", {
    list_id: scope.list_id,
    task_id: scope.task_id,
    attachment_id: scope.attachment_id,
  });

  const stub = ownerIndex(env);
  const tp: TokenProvider = {
    getAccessToken: () => stub.getAccessToken(),
    forceRefresh: () => stub.forceRefresh(),
  };
  const graph = new GraphClient(tp);

  let bytes: Uint8Array | null;
  try {
    bytes = await getAttachmentBytes(graph, scope.list_id, scope.task_id, scope.attachment_id);
  } catch (e) {
    if (e instanceof GraphError) {
      const { reason, detail } = reasonForGraphError(e);
      log.warn("download_graph_error", {
        task_id: scope.task_id,
        attachment_id: scope.attachment_id,
        reason,
      });
      return json({ ok: false, reason, detail }, statusForReason(reason));
    }
    log.error("download_unexpected", {
      task_id: scope.task_id,
      attachment_id: scope.attachment_id,
      error: String(e),
    });
    return json({ ok: false, reason: "unexpected_error" }, 500);
  }

  // Attachment gone, or no contentBytes returned — nothing to serve.
  if (!bytes) {
    log.warn("download_graph_error", {
      task_id: scope.task_id,
      attachment_id: scope.attachment_id,
      reason: "attachment_unreadable",
    });
    return json({ ok: false, reason: "attachment_unreadable" }, 502);
  }

  log.info("download_done", {
    list_id: scope.list_id,
    task_id: scope.task_id,
    attachment_id: scope.attachment_id,
    size: bytes.byteLength,
  });
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": scope.content_type || "application/octet-stream",
      "content-disposition": contentDisposition(scope.filename || "download"),
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
    },
  });
}
