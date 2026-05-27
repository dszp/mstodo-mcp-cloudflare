import { env as rawEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUploadCapability,
  lookupUploadCapability,
} from "../src/upload/tokens";
import {
  consumeDownloadCapability,
  createDownloadCapability,
  downloadLinksEnabled,
  lookupDownloadCapability,
  MAX_DOWNLOAD_TTL_SECONDS,
} from "../src/upload/tokens";

// The test pool types env as Cloudflare.Env (no runtime-injected OAUTH_PROVIDER);
// our helpers take the global Env. Cast once for the file (see index-do.test.ts).
const env = rawEnv as unknown as Env;

const SCOPE = { list_id: "L1", task_id: "T1", attachment_id: "A1" } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("download capability tokens", () => {
  it("round-trips a capability and carries the scope + metadata", async () => {
    const { token } = await createDownloadCapability(env, {
      ...SCOPE,
      filename: "report.pdf",
      content_type: "application/pdf",
      size: 1234,
    });
    const v = await lookupDownloadCapability(env, token);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.list_id).toBe("L1");
      expect(v.value.task_id).toBe("T1");
      expect(v.value.attachment_id).toBe("A1");
      expect(v.value.filename).toBe("report.pdf");
      expect(v.value.content_type).toBe("application/pdf");
      expect(v.value.size).toBe(1234);
    }
  });

  it("mints an opaque id that does not encode the scope", async () => {
    const { token } = await createDownloadCapability(env, SCOPE);
    expect(token).not.toContain("L1");
    expect(token).not.toContain("T1");
    expect(token).not.toContain("A1");
  });

  it("rejects an unknown id as link_invalid", async () => {
    expect(await lookupDownloadCapability(env, "no-such-capability")).toEqual({
      ok: false,
      reason: "link_invalid",
    });
  });

  it("consume makes the link unredeemable (single-use)", async () => {
    const { token } = await createDownloadCapability(env, SCOPE);
    await consumeDownloadCapability(env, token);
    expect((await lookupDownloadCapability(env, token)).ok).toBe(false);
  });

  it("reports an expired capability as link_expired", async () => {
    vi.useFakeTimers();
    const { token } = await createDownloadCapability(env, SCOPE, 60);
    vi.setSystemTime(Date.now() + 61_000);
    const v = await lookupDownloadCapability(env, token);
    expect(v).toEqual({ ok: false, reason: "link_expired" });
  });

  it("clamps the TTL to at most 5 minutes", async () => {
    const before = Date.now();
    const { expiresAt } = await createDownloadCapability(env, SCOPE, 60 * 60);
    const ttlMs = new Date(expiresAt).getTime() - before;
    expect(ttlMs).toBeLessThanOrEqual(MAX_DOWNLOAD_TTL_SECONDS * 1000 + 1000);
  });

  it("isolates the download and upload namespaces", async () => {
    // An upload token must not be redeemable as a download capability...
    const up = await createUploadCapability(env, { list_id: "L1", task_id: "T1" });
    expect((await lookupDownloadCapability(env, up.token)).ok).toBe(false);
    // ...and a download token must not be redeemable as an upload capability.
    const down = await createDownloadCapability(env, SCOPE);
    expect((await lookupUploadCapability(env, down.token)).ok).toBe(false);
  });

  it("is enabled by default and disabled only by an explicit false", () => {
    expect(downloadLinksEnabled({} as unknown as Env)).toBe(true);
    expect(downloadLinksEnabled({ ENABLE_DOWNLOAD_LINKS: "true" } as unknown as Env)).toBe(true);
    expect(downloadLinksEnabled({ ENABLE_DOWNLOAD_LINKS: "false" } as unknown as Env)).toBe(false);
    expect(downloadLinksEnabled({ ENABLE_DOWNLOAD_LINKS: "FALSE" } as unknown as Env)).toBe(false);
  });
});
