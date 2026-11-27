// The Cloudflare Access JWT check (src/core/auth/access.ts), defined once and
// run on both pools: test/access-verifier.test.ts (workerd's WebCrypto) and
// test-node/access-verifier.test.ts (Node's).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  accessSetting,
  accessTokenFrom,
  checkAccess,
  handoffRedirectAllowed,
  verifyAccessJwt,
  KEYS_FETCH_TIMEOUT_MS,
  resetAccessKeyCache,
  KEYS_FRESH_MS,
  KEYS_MAX_STALE_MS,
  KEYS_REFETCH_MIN_MS,
  ACCESS_CLOCK_SKEW_SEC,
  type AccessConfig,
} from "../src/core/auth/access";
import { ACCESS_VARS, AUD, CERTS_URL, ISSUER, OWNER, goodClaims, makeKey, signJwt, stubCerts, type TestKey } from "./_access-keys";

const CONFIG: AccessConfig = { issuer: ISSUER, certsUrl: CERTS_URL, aud: AUD };
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);

export function defineAccessVerifierTests() {
  let k1: TestKey;
  let k2: TestKey;
  let other: TestKey;
  let published: TestKey[];
  let certs: { calls: number; fail: boolean; lastInit?: RequestInit };

  beforeEach(async () => {
    resetAccessKeyCache();
    k1 ??= await makeKey("k1");
    k2 ??= await makeKey("k2");
    other ??= await makeKey("k1"); // same kid as k1, different key
    published = [k1];
    certs = stubCerts(() => published);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetAccessKeyCache();
  });

  const verify = (token: string | null, now = T0) => verifyAccessJwt(token, CONFIG, OWNER, { now });

  describe("accessSetting", () => {
    it("is off when neither variable is set", () => {
      expect(accessSetting({})).toEqual({ state: "off" });
      expect(accessSetting({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: " " })).toEqual({ state: "off" });
    });
    it("is invalid, not off, when only one is set", () => {
      expect(accessSetting({ ACCESS_TEAM_DOMAIN: ACCESS_VARS.ACCESS_TEAM_DOMAIN }).state).toBe("invalid");
      expect(accessSetting({ ACCESS_AUD: AUD }).state).toBe("invalid");
    });
    it("refuses a team domain that isn't a host name, or a malformed AUD", () => {
      expect(accessSetting({ ACCESS_TEAM_DOMAIN: "https://x.example/path", ACCESS_AUD: AUD }).state).toBe("invalid");
      expect(accessSetting({ ACCESS_TEAM_DOMAIN: "team", ACCESS_AUD: AUD }).state).toBe("invalid");
      expect(accessSetting({ ...ACCESS_VARS, ACCESS_AUD: "short" }).state).toBe("invalid");
    });
    it("accepts the bare host or the https URL", () => {
      const want = { state: "on", config: CONFIG };
      expect(accessSetting(ACCESS_VARS)).toEqual(want);
      expect(accessSetting({ ACCESS_TEAM_DOMAIN: `https://${ACCESS_VARS.ACCESS_TEAM_DOMAIN}/`, ACCESS_AUD: AUD })).toEqual(want);
    });
  });

  describe("verifyAccessJwt", () => {
    it("accepts a good token and reports its expiry", async () => {
      const claims = goodClaims(T0);
      const token = await signJwt(k1, claims);
      expect(await verify(token)).toEqual({ ok: true, token, exp: claims.exp });
    });
    it("accepts aud as a string, and the owner's email in any case", async () => {
      expect((await verify(await signJwt(k1, goodClaims(T0, { aud: AUD })))).ok).toBe(true);
      expect((await verify(await signJwt(k1, goodClaims(T0, { email: OWNER.toUpperCase() })))).ok).toBe(true);
    });

    const refusals: Array<[string, (now: number) => Record<string, unknown>, string]> = [
      ["wrong audience", (n) => goodClaims(n, { aud: ["f".repeat(64)] }), "wrong_audience"],
      ["no audience", (n) => goodClaims(n, { aud: undefined }), "wrong_audience"],
      ["wrong issuer", (n) => goodClaims(n, { iss: "https://other-team.cloudflareaccess.com" }), "wrong_issuer"],
      ["expired past the skew", (n) => goodClaims(n, { exp: Math.floor(n / 1000) - ACCESS_CLOCK_SKEW_SEC - 1 }), "expired"],
      ["no exp", (n) => goodClaims(n, { exp: undefined }), "expired"],
      ["not yet valid past the skew", (n) => goodClaims(n, { nbf: Math.floor(n / 1000) + ACCESS_CLOCK_SKEW_SEC + 5 }), "not_yet_valid"],
      ["another person", (n) => goodClaims(n, { email: "someone-else@example.com" }), "not_owner"],
      ["a service token (no email)", (n) => goodClaims(n, { email: undefined, common_name: "svc" }), "not_owner"],
    ];
    for (const [label, claims, reason] of refusals) {
      it(`refuses ${label}`, async () => {
        expect([label, await verify(await signJwt(k1, claims(T0)))]).toEqual([label, { ok: false, reason }]);
      });
    }

    it("allows exp and nbf within the clock skew", async () => {
      const now = Math.floor(T0 / 1000);
      const token = await signJwt(k1, goodClaims(T0, { exp: now - 30, nbf: now + 30 }));
      expect((await verify(token)).ok).toBe(true);
    });

    it("refuses a bad signature: another key under the same kid, or a tampered payload", async () => {
      expect(await verify(await signJwt(other, goodClaims(T0)))).toEqual({ ok: false, reason: "bad_signature" });
      const [h, , s] = (await signJwt(k1, goodClaims(T0))).split(".");
      const forged = btoa(JSON.stringify(goodClaims(T0, { email: OWNER, exp: 9_999_999_999 })))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(await verify(`${h}.${forged}.${s}`)).toEqual({ ok: false, reason: "bad_signature" });
    });

    it("refuses alg none, HS256 and a header without kid", async () => {
      const t = await signJwt(k1, goodClaims(T0));
      const [, p, s] = t.split(".");
      const hdr = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(await verify(`${hdr({ alg: "none", kid: "k1" })}.${p}.`)).toEqual({ ok: false, reason: "malformed" });
      expect(await verify(`${hdr({ alg: "none", kid: "k1" })}.${p}.${s}`)).toEqual({ ok: false, reason: "unsupported_alg" });
      expect(await verify(`${hdr({ alg: "HS256", kid: "k1" })}.${p}.${s}`)).toEqual({ ok: false, reason: "unsupported_alg" });
      expect(await verify(`${hdr({ alg: "RS256" })}.${p}.${s}`)).toEqual({ ok: false, reason: "malformed" });
    });

    it("refuses a missing or malformed token without fetching keys", async () => {
      expect(await verify(null)).toEqual({ ok: false, reason: "missing" });
      expect(await verify("")).toEqual({ ok: false, reason: "missing" });
      expect(await verify("not-a-jwt")).toEqual({ ok: false, reason: "malformed" });
      expect(await verify("a.b.c.d")).toEqual({ ok: false, reason: "malformed" });
      expect(await verify(`${"a".repeat(20_000)}.b.c`)).toEqual({ ok: false, reason: "malformed" });
      expect(certs.calls).toBe(0);
    });
  });

  describe("the team's keys", () => {
    it("fetches once and serves later tokens from the cache", async () => {
      const token = await signJwt(k1, goodClaims(T0));
      await verify(token);
      await verify(token, T0 + 1000);
      expect(certs.calls).toBe(1);
    });

    it("refetches on an unknown kid (rotation) and then accepts the new key", async () => {
      await verify(await signJwt(k1, goodClaims(T0)));
      published = [k1, k2];
      const later = T0 + KEYS_REFETCH_MIN_MS;
      expect((await verify(await signJwt(k2, goodClaims(later)), later)).ok).toBe(true);
      expect(certs.calls).toBe(2);
    });

    it("refetches for unknown kids at most once a minute", async () => {
      await verify(await signJwt(k1, goodClaims(T0)));
      const stranger = await signJwt(k2, goodClaims(T0));
      for (let i = 1; i <= 5; i++) {
        expect(await verify(stranger, T0 + i * 1000)).toEqual({ ok: false, reason: "unknown_key" });
      }
      expect(certs.calls).toBe(1);
      published = [k2];
      expect((await verify(stranger, T0 + KEYS_REFETCH_MIN_MS)).ok).toBe(true);
      expect(certs.calls).toBe(2);
    });

    it("shares one fetch between concurrent requests", async () => {
      const token = await signJwt(k1, goodClaims(T0));
      const results = await Promise.all([verify(token), verify(token), verify(token)]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(certs.calls).toBe(1);
    });

    it("refreshes stale keys, and keeps using them for a day when the refresh fails", async () => {
      const token = (now: number) => signJwt(k1, goodClaims(now));
      await verify(await token(T0));
      certs.fail = true;
      const stale = T0 + KEYS_FRESH_MS + 1;
      expect((await verify(await token(stale), stale)).ok).toBe(true);
      expect(certs.calls).toBe(2);
      const tooOld = T0 + KEYS_MAX_STALE_MS;
      expect(await verify(await token(tooOld), tooOld)).toEqual({ ok: false, reason: "keys_unavailable" });
    });

    it("fetches the keys without following redirects, with a timeout", async () => {
      await verify(await signJwt(k1, goodClaims(T0)));
      expect(certs.lastInit?.redirect).toBe("error");
      expect(certs.lastInit?.signal).toBeInstanceOf(AbortSignal);
      expect(KEYS_FETCH_TIMEOUT_MS).toBe(5000);
    });

    it("fails closed when the keys can't be fetched at all", async () => {
      certs.fail = true;
      expect(await verify(await signJwt(k1, goodClaims(T0)))).toEqual({ ok: false, reason: "keys_unavailable" });
    });
  });

  describe("handoffRedirectAllowed", () => {
    it("allows only exact entries, and nothing when unset", () => {
      const env = { ACCESS_HANDOFF_REDIRECT_URIS: " https://app.example/oauth/callback , http://127.0.0.1:9/cb" };
      expect(handoffRedirectAllowed(env, "https://app.example/oauth/callback")).toBe(true);
      expect(handoffRedirectAllowed(env, "http://127.0.0.1:9/cb")).toBe(true);
      expect(handoffRedirectAllowed(env, "https://app.example/oauth/callback/")).toBe(false);
      expect(handoffRedirectAllowed(env, "https://app.example/oauth")).toBe(false);
      expect(handoffRedirectAllowed({}, "https://app.example/oauth/callback")).toBe(false);
      expect(handoffRedirectAllowed({ ACCESS_HANDOFF_REDIRECT_URIS: "" }, "")).toBe(false);
    });
  });

  describe("accessTokenFrom", () => {
    const h = (init: Record<string, string>) => new Headers(init);
    it("prefers the assertion Access adds, then cf-access-token", () => {
      expect(accessTokenFrom(h({ "cf-access-jwt-assertion": "A", "cf-access-token": "B" }), { cookie: false })).toBe("A");
      expect(accessTokenFrom(h({ "cf-access-token": "B", cookie: "CF_Authorization=C" }), { cookie: true })).toBe("B");
    });
    it("reads the CF_Authorization cookie only when allowed", () => {
      const headers = h({ cookie: "x=1; CF_Authorization=C; y=2" });
      expect(accessTokenFrom(headers, { cookie: true })).toBe("C");
      expect(accessTokenFrom(headers, { cookie: false })).toBeNull();
    });
    it("is null with nothing to read", () => {
      expect(accessTokenFrom(h({}), { cookie: true })).toBeNull();
    });
  });

  describe("checkAccess", () => {
    const env = (vars: Record<string, string>) => ({ OWNER_EMAIL: OWNER, ...vars });
    it("is off, and fetches nothing, without configuration", async () => {
      expect(await checkAccess(new Headers(), env({}), { cookie: false, path: "/x" })).toEqual({ state: "off" });
      expect(certs.calls).toBe(0);
    });
    it("refuses with 503 when half configured", async () => {
      expect(await checkAccess(new Headers(), env({ ACCESS_AUD: AUD }), { cookie: false, path: "/x" })).toEqual({
        state: "refused",
        status: 503,
        error: "access_misconfigured",
      });
    });
    it("refuses with 403 without a valid token, and passes a valid one", async () => {
      expect(await checkAccess(new Headers(), env(ACCESS_VARS), { cookie: false, path: "/x" })).toMatchObject({
        state: "refused",
        status: 403,
      });
      const token = await signJwt(k1, goodClaims());
      expect(
        await checkAccess(new Headers({ "cf-access-token": token }), env(ACCESS_VARS), { cookie: false, path: "/x" }),
      ).toMatchObject({ state: "passed", token });
    });
    it("answers 503 access_unavailable, not 403, when the keys can't be fetched", async () => {
      certs.fail = true;
      const token = await signJwt(k1, goodClaims());
      expect(
        await checkAccess(new Headers({ "cf-access-token": token }), env(ACCESS_VARS), { cookie: false, path: "/x" }),
      ).toEqual({ state: "refused", status: 503, error: "access_unavailable" });
    });
    it("never logs the token", async () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const token = await signJwt(k1, goodClaims(Date.now(), { email: "intruder@example.com" }));
      await checkAccess(new Headers({ "cf-access-token": token }), env(ACCESS_VARS), { cookie: false, path: "/x" });
      const logged = spy.mock.calls.flat().join(" ");
      spy.mockRestore();
      expect(logged).toContain("not_owner");
      expect(logged).not.toContain(token.split(".")[1]);
      expect(logged).not.toContain("intruder");
    });
  });
}
