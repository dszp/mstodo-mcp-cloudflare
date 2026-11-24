// Test Cloudflare Access: an RSA key pair made in the test, JWTs signed with
// it, and a stand-in for the team's certs endpoint. Shared by both pools.
import { vi } from "vitest";

export const TEAM = "test-team.cloudflareaccess.com";
export const ISSUER = `https://${TEAM}`;
export const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
export const AUD = "0123456789abcdef".repeat(4);
export const OWNER = "test-owner@example.com";
export const ACCESS_VARS = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { kty: "RSA", n: pub.n, e: pub.e, alg: "RS256", use: "sig", kid } };
}

const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

export async function signJwt(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const input = `${enc({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

// The claims of a good token for this app and the owner at `nowMs`.
export function goodClaims(nowMs = Date.now(), over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(nowMs / 1000);
  return {
    aud: [AUD],
    email: OWNER,
    exp: now + 3600,
    iat: now,
    nbf: now,
    iss: ISSUER,
    type: "app",
    sub: "access-user-1",
    ...over,
  };
}

// Answers the certs URL with whatever keys() returns at the time; counts calls.
// `fail` makes it answer 503. Any other URL goes to `fallback` (or 404).
export function certsEndpoint(keys: () => TestKey[]) {
  const state: { calls: number; fail: boolean; lastInit?: RequestInit } = { calls: 0, fail: false };
  const answer = (url: string, init?: RequestInit): Response | undefined => {
    if (url !== CERTS_URL) return undefined;
    state.calls++;
    state.lastInit = init;
    if (state.fail) return new Response("unavailable", { status: 503 });
    return Response.json({ keys: keys().map((k) => k.jwk), public_cert: {}, public_certs: [] });
  };
  return { state, answer };
}

// Stubs global fetch with the certs endpoint alone.
export function stubCerts(keys: () => TestKey[]) {
  const certs = certsEndpoint(keys);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return certs.answer(url, init) ?? new Response("unscripted", { status: 404 });
  });
  return certs.state;
}
