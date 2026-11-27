// An in-memory BlobStore for node tests: what R2 does, minus the network.
import type { BlobStore } from "../src/core/ports";

export function memoryBlobs() {
  const objects = new Map<string, { bytes: Uint8Array; type?: string; uploaded: Date }>();
  const store: BlobStore = {
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return { body: new Blob([o.bytes]).stream(), size: o.bytes.byteLength, httpMetadata: { contentType: o.type } };
    },
    async put(key, value, options) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, { bytes: new Uint8Array(bytes), type: options?.httpMetadata?.contentType, uploaded: new Date(0) });
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list({ prefix }) {
      return {
        objects: [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, uploaded: o.uploaded })),
        truncated: false,
      };
    },
  };
  return { store, objects };
}
