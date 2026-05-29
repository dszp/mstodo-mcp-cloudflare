import { env as rawEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TTL_SECONDS,
  consumeUploadCapability,
  createUploadCapability,
  lookupUploadCapability,
} from "../src/upload/tokens";

// The test pool types env as Cloudflare.Env (no runtime-injected OAUTH_PROVIDER);
// our helpers take the global Env. Cast once for the file (see index-do.test.ts).
const env = rawEnv as unknown as Env;

const SCOPE = { list_id: "L1", task_id: "T1" } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("upload capability tokens", () => {
  it("round-trips a capability and carries the scope", async () => {
    const { token } = await createUploadCapability(env, { ...SCOPE, filename: "report.pdf" });
    const v = await lookupUploadCapability(env, token);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.list_id).toBe("L1");
      expect(v.value.task_id).toBe("T1");
      expect(v.value.filename).toBe("report.pdf");
    }
  });

  it("mints an opaque id that does not encode the scope", async () => {
    // Use realistic long, opaque ids (like real Graph ids). The 43-char random
    // base64url token cannot contain a 50-char id, so the "doesn't leak the
    // scope" check is deterministic — short ids like "L1"/"T1" could appear as a
    // coincidental substring of the random id and false-fail ~1-2% of runs.
    const scope = {
      list_id: "AAMkListId_0123456789abcdefABCDEF_unique_list_marker",
      task_id: "AAMkTaskId_0123456789abcdefABCDEF_unique_task_marker",
    };
    const { token } = await createUploadCapability(env, scope);
    // The link id is random — it must not leak the list/task it targets.
    expect(token).not.toContain(scope.list_id);
    expect(token).not.toContain(scope.task_id);
  });

  it("rejects an unknown id as link_invalid", async () => {
    expect(await lookupUploadCapability(env, "no-such-capability")).toEqual({
      ok: false,
      reason: "link_invalid",
    });
  });

  it("treats a capability past its exp as link_expired", async () => {
    const start = Date.now();
    const { token } = await createUploadCapability(env, SCOPE, 60);
    vi.useFakeTimers();
    vi.setSystemTime(start + 61_000);
    expect(await lookupUploadCapability(env, token)).toEqual({ ok: false, reason: "link_expired" });
  });

  it("is single-use: a consumed capability is link_invalid", async () => {
    const { token } = await createUploadCapability(env, SCOPE);
    expect((await lookupUploadCapability(env, token)).ok).toBe(true);
    await consumeUploadCapability(env, token);
    expect(await lookupUploadCapability(env, token)).toEqual({ ok: false, reason: "link_invalid" });
  });

  it("clamps the ttl to [60, MAX_TTL_SECONDS]", async () => {
    const before = Date.now();
    const low = await createUploadCapability(env, SCOPE, 5);
    const lowSecs = Math.round((Date.parse(low.expiresAt) - before) / 1000);
    expect(lowSecs).toBeGreaterThanOrEqual(59);
    expect(lowSecs).toBeLessThanOrEqual(61);

    const high = await createUploadCapability(env, SCOPE, 99_999);
    const highSecs = Math.round((Date.parse(high.expiresAt) - before) / 1000);
    expect(highSecs).toBeGreaterThanOrEqual(MAX_TTL_SECONDS - 2);
    expect(highSecs).toBeLessThanOrEqual(MAX_TTL_SECONDS + 1);
  });
});
