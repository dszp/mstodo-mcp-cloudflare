// AES-256-GCM sealing for cookie values. WebCrypto only, so the same code runs
// on Workers and on Node.

const enc = new TextEncoder();
const dec = new TextDecoder();

const MIN_SECRET_BYTES = 32;
const IV_BYTES = 12;
// Fixed, empty salt: the secret is already high-entropy key material, and a
// per-deployment salt would have to be stored somewhere to re-derive the key.
const HKDF_SALT = new Uint8Array(0);

export interface Sealer {
  seal(name: string, value: unknown): Promise<string>;
  unseal<T>(name: string, sealed: string): Promise<T | null>;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function sealer(secret: string): Promise<Sealer> {
  const secretBytes = enc.encode(secret);
  if (secretBytes.length < MIN_SECRET_BYTES) {
    throw new Error(`WEB_SESSION_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  const material = await crypto.subtle.importKey("raw", secretBytes, "HKDF", false, ["deriveKey"]);
  const keys = new Map<string, Promise<CryptoKey>>();

  // One derived key per cookie name, so a value sealed for one cookie is
  // meaningless in another.
  const keyFor = (name: string): Promise<CryptoKey> => {
    let k = keys.get(name);
    if (!k) {
      k = crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: enc.encode(`potem-web/${name}`) },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      keys.set(name, k);
    }
    return k;
  };

  return {
    async seal(name, value) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: enc.encode(name) },
          await keyFor(name),
          enc.encode(JSON.stringify(value)),
        ),
      );
      const out = new Uint8Array(iv.length + ct.length);
      out.set(iv);
      out.set(ct, iv.length);
      return toBase64Url(out);
    },

    async unseal<T>(name: string, sealed: string): Promise<T | null> {
      const bytes = fromBase64Url(sealed);
      // IV plus the 16-byte GCM tag is the shortest possible valid value.
      if (!bytes || bytes.length < IV_BYTES + 16) return null;
      try {
        const pt = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES), additionalData: enc.encode(name) },
          await keyFor(name),
          bytes.slice(IV_BYTES),
        );
        return JSON.parse(dec.decode(pt)) as T;
      } catch {
        return null;
      }
    },
  };
}
