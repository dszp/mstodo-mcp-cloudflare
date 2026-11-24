// GET /api/v1/attachments/{sid} — one attachment's bytes, streamed from Graph
// (docs/SYNC-API.md sections 4.2 and 10.2). The feed carries only an
// attachment's metadata; the app fetches the file here with its /api/v1 token.
// While Graph is the source the bytes are never stored: Graph's `$value`
// response body is passed through unread, so a 25 MB file is never held in
// memory. The handler is reached only through handleApiRequest, after the
// resource server and the grant gate.
import { isReauthRequired } from "../auth/reauth";
import { GraphClient, GraphError } from "../graph/client";
import { log } from "../log";
import { ownerIndex } from "../owner-index";
import type { AppEnv } from "../ports";
import { contentDisposition } from "../upload/handler";
import { openAttachmentStream } from "../upload/graph-upload";
import { json } from "./respond";

// sids are UUIDs; anything else can't name an attachment.
const SID_RE = /^[0-9A-Za-z-]{1,64}$/;

export async function attachmentBySid(rawSid: string, env: AppEnv): Promise<Response> {
  let sid: string;
  try {
    sid = decodeURIComponent(rawSid);
  } catch {
    return json({ error: "not_found" }, 404);
  }
  if (!SID_RE.test(sid)) return json({ error: "not_found" }, 404);

  const index = ownerIndex(env);
  const att = await index.syncAttachment(sid);
  // Unknown sid, an attachment deleted from the mirror, or one in an excluded
  // list: all the same to the app, which drops it on its next pull.
  if (!att) return json({ error: "not_found" }, 404);
  // A reference attachment is a link, not a file: Graph has no bytes for it.
  if (att.kind === "reference") return json({ error: "not_a_file" }, 409);

  const graph = new GraphClient({
    getAccessToken: () => index.getAccessToken(),
    forceRefresh: () => index.refreshToken(),
    reportClaimsChallenge: (claims: string) => index.markReauthRequired("claims_challenge", claims),
  });

  let upstream: Response;
  try {
    upstream = await openAttachmentStream(graph, att.list_id, att.task_id, att.attachment_id);
  } catch (e) {
    return graphFailure(e, att.attachment_id);
  }

  const headers: Record<string, string> = {
    "content-type": att.content_type || "application/octet-stream",
    "content-disposition": contentDisposition(att.name || "attachment"),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  // Graph's length, not the mirror's size: the mirror can lag an edit, and a
  // wrong Content-Length breaks the response.
  const length = upstream.headers.get("content-length");
  if (length && /^\d+$/.test(length)) headers["content-length"] = length;
  return new Response(upstream.body, { status: 200, headers });
}

// Graph refused or failed. `retry` tells the app whether trying again later
// can succeed, the same flag a failed mutation carries (section 5.3).
function graphFailure(e: unknown, attachmentId: string): Response {
  const message = e instanceof Error ? e.message : String(e);
  if (isReauthRequired(e) || message.includes("not_authenticated") || (e instanceof GraphError && e.status === 401)) {
    return json({ error: "reauth_required", retry: true }, 503);
  }
  if (e instanceof GraphError) {
    // Gone upstream (deleted in another app since the last sync). The next
    // delta or sub-resource scan removes it from the feed.
    if (e.status === 404 || (e.status === 400 && (e.detail ?? "").includes("ErrorInvalidIdMalformed"))) {
      return json({ error: "not_found" }, 404);
    }
    log.warn("attachment_download_graph_error", { attachment_id: attachmentId, status: e.status });
    if (e.status === 429) return json({ error: "graph_throttled", retry: true }, 503);
    if (e.status >= 500) return json({ error: "graph_unavailable", retry: true }, 502);
    return json({ error: `graph_${e.status}`, retry: false }, 502);
  }
  // fetch() rejects with a TypeError when the network fails.
  if (e instanceof TypeError) return json({ error: "graph_unavailable", retry: true }, 502);
  log.error("attachment_download_failed", { attachment_id: attachmentId, error: message });
  return json({ error: "internal_error", retry: true }, 500);
}
