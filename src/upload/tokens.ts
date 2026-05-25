// Short-lived, single-use capability tokens for the web attachment-upload flow.
//
// `create_upload_link` stores the destination scope (list_id + task_id, optional
// filename / max_files) in OAUTH_KV under a random opaque id with a TTL, and
// hands out a link carrying just that id. The id is an unguessable capability
// (32 random bytes from the CSPRNG): holding it is authorization to upload to
// exactly the scoped task, once, before it expires. There is NO shared signing
// secret — the random id IS the nonce. Verification is a KV lookup; expiry is
// the KV TTL; single-use is enforced by deleting the entry on use.

const KV_PREFIX = "upload:";
const DEFAULT_TTL_SECONDS = 15 * 60;
export const MAX_TTL_SECONDS = 30 * 60;

/** Batch links accept up to this many files; the create_upload_link tool clamps. */
export const DEFAULT_MAX_FILES = 5;
export const MAX_FILES_CAP = 10;

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface UploadCapabilityScope {
  /** Canonical Graph list id the task lives in. */
  list_id: string;
  /** Graph task id the upload attaches to. */
  task_id: string;
  /** When set, a single-file link: the attachment is stored under this name. */
  filename?: string;
  /** Optional MIME hint baked at mint time (sniffing still overrides it). */
  content_type?: string;
  /** Max files a batch link accepts. Absent ⇒ single-file link (one file). */
  max_files?: number;
}

interface StoredCapability extends UploadCapabilityScope {
  exp: number; // epoch seconds — defense-in-depth alongside the KV TTL
}

export interface UploadCapability {
  /** The opaque random id placed in the upload link (`/upload?t=<token>`). */
  token: string;
  expiresAt: string; // ISO
}

// 32 bytes of CSPRNG output, base64url — an unguessable capability id.
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a single-use upload capability: persist the scope in KV under a random id
 * with a matching TTL, and return the id to embed in the link. `ttlSeconds` is
 * clamped to [60, MAX_TTL_SECONDS].
 */
export async function createUploadCapability(
  env: Env,
  scope: UploadCapabilityScope,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<UploadCapability> {
  const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 60), MAX_TTL_SECONDS);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const id = randomId();
  const stored: StoredCapability = { ...scope, exp };
  await env.OAUTH_KV.put(KV_PREFIX + id, JSON.stringify(stored), { expirationTtl: ttl });
  return { token: id, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Look up a capability by its id. A KV miss means the link never existed, has
 * expired (TTL), or was already consumed — all indistinguishable and reported as
 * `link_invalid`. Does NOT consume — call `consumeUploadCapability` after use.
 */
export async function lookupUploadCapability(
  env: Env,
  token: string,
): Promise<Result<UploadCapabilityScope>> {
  if (!token) return { ok: false, reason: "link_invalid" };
  const raw = (await env.OAUTH_KV.get(KV_PREFIX + token, "json")) as StoredCapability | null;
  if (raw === null) return { ok: false, reason: "link_invalid" };
  if (!raw.list_id || !raw.task_id || typeof raw.exp !== "number") {
    return { ok: false, reason: "link_invalid" };
  }
  if (raw.exp * 1000 < Date.now()) return { ok: false, reason: "link_expired" };
  return {
    ok: true,
    value: {
      list_id: raw.list_id,
      task_id: raw.task_id,
      filename: raw.filename,
      content_type: raw.content_type,
      max_files: raw.max_files,
    },
  };
}

/** Consume a capability so the link cannot be replayed. */
export async function consumeUploadCapability(env: Env, token: string): Promise<void> {
  await env.OAUTH_KV.delete(KV_PREFIX + token);
}
