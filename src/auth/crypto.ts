// Server-side keys derived from the MS_CLIENT_SECRET Worker secret.
//
// Two features need a server-held key: encrypting the Microsoft tokens at rest
// in KV, and signing the "remember this client" consent cookie. Deriving both
// from the existing confidential-client secret (HKDF, distinct `info` labels so
// the keys are independent) means a deploy needs no new secret. Rotating the
// Entra client secret rotates both keys: stored tokens become undecryptable
// (loadTokens treats that as "not authenticated" → one re-authorize) and
// remembered consents lapse (the consent page shows again). Worker secrets are
// write-only through the Cloudflare API, so someone who can read KV still can't
// read the key.

const enc = new TextEncoder();

async function hkdfBits(secret: string, info: string, bits: number): Promise<ArrayBuffer> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("mstodo-mcp"), info: enc.encode(info) },
    ikm,
    bits,
  );
}

function requireSecret(env: Env): string {
  const secret = env.MS_CLIENT_SECRET ?? "";
  if (secret.length === 0) throw new Error("ms_client_secret_missing");
  return secret;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 64 hex chars — the library's remembered-consent cookie wants a 32+ char secret.
export async function consentRememberSecret(env: Env): Promise<string> {
  const bits = new Uint8Array(await hkdfBits(requireSecret(env), "consent-remember-v1", 256));
  return [...bits].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function tokenKey(env: Env): Promise<CryptoKey> {
  const bits = await hkdfBits(requireSecret(env), "token-encryption-v1", 256);
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const SEALED_PREFIX = "v1:";

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

// AES-256-GCM, random 96-bit IV, stored as "v1:" + base64(iv || ciphertext).
// `aad` binds the ciphertext to its KV key, so a sealed value can't be moved
// to a different key and still decrypt.
export async function seal(env: Env, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    await tokenKey(env),
    enc.encode(plaintext),
  );
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), iv.length);
  return SEALED_PREFIX + toBase64(out);
}

// Throws on a tampered value or a key that no longer matches (rotated secret).
export async function unseal(env: Env, sealed: string, aad: string): Promise<string> {
  const raw = fromBase64(sealed.slice(SEALED_PREFIX.length));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: enc.encode(aad) },
    await tokenKey(env),
    raw.slice(12),
  );
  return new TextDecoder().decode(pt);
}
