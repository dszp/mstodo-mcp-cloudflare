import { UPLOAD_BODY_MAX_BYTES } from "../../core/upload/handler";

// Request body caps for the Node host. On Cloudflare the platform bounds every
// request body; a Node process has no such limit, and several routes buffer the
// whole body before authenticating it (the OAuth library's /token and /register,
// core's /upload formData()). Without a cap one unauthenticated request can
// exhaust the process's memory.
export const KiB = 1024;
export const MiB = 1024 * KiB;

const OAUTH_MAX_BYTES = 64 * KiB;
const WEBHOOK_MAX_BYTES = 64 * KiB; // core's webhook handler reads at most this much too
const MCP_MAX_BYTES = 4 * MiB; // the MCP SDK transport's own limit
const DEFAULT_MAX_BYTES = 1 * MiB;

export function bodyCapFor(pathname: string): number {
  if (pathname === "/mcp") return MCP_MAX_BYTES;
  if (pathname === "/upload") return UPLOAD_BODY_MAX_BYTES;
  if (pathname === "/webhook") return WEBHOOK_MAX_BYTES;
  if (
    pathname === "/register" ||
    pathname === "/token" ||
    pathname === "/authorize" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/.well-known/")
  ) {
    return OAUTH_MAX_BYTES;
  }
  return DEFAULT_MAX_BYTES;
}

export function tooLarge(max: number): Response {
  return Response.json({ ok: false, reason: "body_too_large", max }, { status: 413 });
}

// A declared Content-Length over the cap is refused before anything reads the
// body. A chunked body (no declared length), or one longer than it declared, is
// passed through a counting stream that errors once the cap is crossed; the
// error cancels the client's stream, so at most `max` bytes are ever buffered.
// exceeded() tells the caller to answer 413 whatever the route made of the
// truncated body.
export function limitBody(req: Request, max: number): Response | { req: Request; exceeded(): boolean } {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return tooLarge(max);
  if (!req.body) return { req, exceeded: () => false };

  let seen = 0;
  let over = false;
  const counted = req.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > max) {
          over = true;
          ctl.error(new Error("request body exceeds the cap"));
          return;
        }
        ctl.enqueue(chunk);
      },
    }),
  );
  const limited = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: counted,
    signal: req.signal,
    redirect: req.redirect,
    duplex: "half",
  } as RequestInit);
  return { req: limited, exceeded: () => over };
}
