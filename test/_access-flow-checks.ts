// Cloudflare Access through a host's whole OAuth front (docs/SYNC-API.md
// section 8.1): the /api/v1 gate, /app/signin, the Access token handed over at
// code redemption, the socket upgrade, and what stays outside Access. Run by
// test/access-flow.test.ts and test-node/access-flow.test.ts.
import { expect } from "vitest";
import { resetAccessKeyCache } from "@potem/core/auth/access";
import type { AppEnv } from "@potem/core/ports";
import { ORIGIN, REDIRECT_URI, oauthClient, stubMicrosoft } from "../test-node/_oauth-client";

// Another redirect URI the test client registers, never in the allowlist.
const OTHER_REDIRECT_URI = "http://localhost:9/other";
import { OWNER, certsEndpoint, goodClaims, makeKey, signJwt } from "./_access-keys";

type FetchFn = (req: Request) => Promise<Response>;

const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function stubAccess() {
  resetAccessKeyCache();
  const key = await makeKey("k1");
  const certs = certsEndpoint(() => [key]);
  stubMicrosoft(OWNER, (url, init) => certs.answer(url, init));
  return {
    certs: certs.state,
    good: () => signJwt(key, goodClaims()),
    stranger: () => signJwt(key, goodClaims(Date.now(), { email: "someone-else@example.com" })),
  };
}

// `socket` opens /api/v1/sync/socket with the given headers and reports
// whether it was let through.
// Access configured (ACCESS_TEAM_DOMAIN + ACCESS_AUD, and
// ACCESS_HANDOFF_REDIRECT_URIS = REDIRECT_URI). `setVar` changes one variable
// on the live host env.
export async function runAccessOnChecks(
  env: AppEnv,
  fetchFn: FetchFn,
  socket: (h: Headers) => Promise<boolean>,
  setVar: (name: "ACCESS_HANDOFF_REDIRECT_URIS", value: string | undefined) => void,
) {
  const access = await stubAccess();
  const good = await access.good();
  const client = oauthClient(fetchFn);
  const status = async (label: string, res: Response, want: number) => {
    expect([label, res.status]).toEqual([label, want]);
    return res;
  };

  // The anonymous info probe is behind Access too.
  const denied = await status("probe without Access", await client.send("/api/v1/sync/info"), 403);
  expect(await denied.json()).toEqual({ error: "access_denied" });
  expect(denied.headers.get("cache-control")).toBe("no-store");
  const probe = await status(
    "probe with Access",
    await client.send("/api/v1/sync/info", { headers: { "cf-access-jwt-assertion": good } }),
    200,
  );
  expect(Object.keys((await probe.json()) as object)).toEqual(["server_id"]);

  // A plain /api/v1 grant (through /authorize, which stays outside Access) is
  // not enough on its own; nor is another person's Access token.
  const api = await client.connect(`${ORIGIN}/api/v1`);
  expect(api).not.toHaveProperty("cf_access_token");
  const bearer = { authorization: `Bearer ${api.access_token}` };
  await status("bearer only", await client.send("/api/v1/sync/changes", { headers: bearer }), 403);
  await status(
    "bearer + another person's Access token",
    await client.send("/api/v1/sync/changes", { headers: { ...bearer, "cf-access-token": await access.stranger() } }),
    403,
  );
  await status(
    "bearer + cf-access-token",
    await client.send("/api/v1/sync/changes", { headers: { ...bearer, "cf-access-token": good } }),
    200,
  );
  await status(
    "bearer + assertion",
    await client.send("/api/v1/sync/changes", { headers: { ...bearer, "cf-access-jwt-assertion": good } }),
    200,
  );
  // A route the gate has never heard of is still behind it.
  await status("unknown route", await client.send("/api/v1/attachments/x", { headers: bearer }), 403);
  // Access doesn't stand in for the OAuth token either.
  await status(
    "Access only",
    await client.send("/api/v1/sync/changes", { headers: { "cf-access-token": good } }),
    401,
  );

  // The socket upgrade.
  const up = (extra: Record<string, string>) => new Headers({ upgrade: "websocket", ...bearer, ...extra });
  expect(["socket without Access", await socket(up({}))]).toEqual(["socket without Access", false]);
  expect(["socket with Access", await socket(up({ "cf-access-token": good }))]).toEqual(["socket with Access", true]);

  // Outside Access: /mcp, OAuth discovery.
  const mcp = await client.connect(`${ORIGIN}/mcp`);
  const mcpRes = await client.send("/mcp", { method: "POST", headers: { authorization: `Bearer ${mcp.access_token}` } });
  expect(["/mcp without Access", [401, 403].includes(mcpRes.status)]).toEqual(["/mcp without Access", false]);
  await status("resource metadata", await client.send("/.well-known/oauth-protected-resource/api/v1"), 200);
  await status("AS metadata", await client.send("/.well-known/oauth-authorization-server"), 200);

  // /app/signin.
  const reg = await client.send("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI, OTHER_REDIRECT_URI], token_endpoint_auth_method: "none", client_name: "App" }),
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = await pkce();
  const params = (over: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: "app-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${ORIGIN}/api/v1`,
      ...over,
    });

  await status("signin without Access", await client.send(`/app/signin?${params()}`), 403);
  const withAccess = { headers: { "cf-access-jwt-assertion": good } };
  // A redirect URI outside ACCESS_HANDOFF_REDIRECT_URIS never gets the token,
  // even for a client the owner would consent to.
  await status(
    "signin to a redirect URI not in the allowlist",
    await client.send(`/app/signin?${params({ redirect_uri: OTHER_REDIRECT_URI })}`, withAccess),
    400,
  );
  // A parameter given twice could be read differently by /authorize.
  for (const name of ["resource", "client_id", "redirect_uri", "code_challenge"]) {
    const q = params();
    q.append(name, name === "resource" ? `${ORIGIN}/mcp` : "x");
    await status(`signin with ${name} twice`, await client.send(`/app/signin?${q}`, withAccess), 400);
  }
  expect((await env.OAUTH_KV.list({ prefix: "access_handoff:" })).keys).toEqual([]);
  await status(
    "signin for the /mcp resource",
    await client.send(`/app/signin?${params({ resource: `${ORIGIN}/mcp` })}`, { headers: { "cf-access-jwt-assertion": good } }),
    400,
  );
  await status(
    "signin without PKCE S256",
    await client.send(`/app/signin?${params({ code_challenge_method: "plain" })}`, { headers: { "cf-access-jwt-assertion": good } }),
    400,
  );

  // The browser's CF_Authorization cookie is accepted here.
  const start = await status(
    "signin with the Access cookie",
    await client.send(`/app/signin?${params()}`, { headers: { cookie: `CF_Authorization=${good}` } }),
    302,
  );
  const next = new URL(start.headers.get("location")!);
  expect(next.origin + next.pathname).toBe(`${ORIGIN}/authorize`);
  expect(Object.fromEntries(next.searchParams)).toEqual(Object.fromEntries(params()));
  // Never in a redirect URL.
  expect(start.headers.get("location")).not.toContain(good);

  const code = await authorizeAndGetCode(client, next);
  const tok = await client.send(
    "/token",
    client.form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
  );
  await status("token", tok, 200);
  const body = (await tok.json()) as Record<string, unknown>;
  expect(body.cf_access_token).toBe(good);
  const goodExp = (JSON.parse(atob(good.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp: number }).exp;
  expect(body.cf_access_expires_at).toBe(goodExp);
  expect(typeof body.access_token).toBe("string");
  expect(tok.headers.get("cache-control")).toBe("no-store");
  // The handed-over token works on /api/v1 with the new bearer.
  await status(
    "app tokens on /api/v1",
    await client.send("/api/v1/sync/changes", {
      headers: { authorization: `Bearer ${body.access_token}`, "cf-access-token": body.cf_access_token as string },
    }),
    200,
  );
  // A refresh doesn't hand it over again: the grant kept no trace of it.
  const refreshed = await client.send(
    "/token",
    client.form({ grant_type: "refresh_token", refresh_token: body.refresh_token as string, client_id: clientId }),
  );
  await status("refresh", refreshed, 200);
  expect(await refreshed.json()).not.toHaveProperty("cf_access_token");
  expect((await env.OAUTH_KV.list({ prefix: "access_handoff:" })).keys).toEqual([]);

  // A handoff started for one authorization doesn't attach to another: the
  // browser starts at /app/signin, then a different PKCE challenge is used.
  const other = await pkce();
  const started = await client.send(`/app/signin?${params()}`, { headers: { "cf-access-jwt-assertion": good } });
  await status("second signin", started, 302);
  const swapped = new URL(`${ORIGIN}/authorize?${params({ code_challenge: other.challenge })}`);
  const code2 = await authorizeAndGetCode(client, swapped);
  const tok2 = await client.send(
    "/token",
    client.form({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: other.verifier }),
  );
  await status("token for the swapped authorization", tok2, 200);
  expect(await tok2.json()).not.toHaveProperty("cf_access_token");
  expect((await env.OAUTH_KV.list({ prefix: "access_handoff:" })).keys).toEqual([]);

  // The allowlist is checked again at the callback: a redirect URI removed
  // from it after sign-in started gets no token.
  const third = await pkce();
  const begun = await client.send(`/app/signin?${params({ code_challenge: third.challenge })}`, withAccess);
  await status("third signin", begun, 302);
  setVar("ACCESS_HANDOFF_REDIRECT_URIS", undefined);
  const code3 = await authorizeAndGetCode(client, new URL(begun.headers.get("location")!));
  setVar("ACCESS_HANDOFF_REDIRECT_URIS", REDIRECT_URI);
  const tok3 = await client.send(
    "/token",
    client.form({ grant_type: "authorization_code", code: code3, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: third.verifier }),
  );
  await status("token after the allowlist changed", tok3, 200);
  expect(await tok3.json()).not.toHaveProperty("cf_access_token");
  expect((await env.OAUTH_KV.list({ prefix: "access_handoff:" })).keys).toEqual([]);

  // The team's keys can't be fetched: 503 with a retry hint, not access_denied,
  // so the app retries instead of signing in again.
  resetAccessKeyCache();
  access.certs.fail = true;
  const outage = await status(
    "keys unavailable",
    await client.send("/api/v1/sync/changes", { headers: { ...bearer, "cf-access-token": good } }),
    503,
  );
  expect(await outage.json()).toEqual({ error: "access_unavailable" });
  expect(outage.headers.get("retry-after")).toBe("30");
  access.certs.fail = false;
}

// GET /authorize (consent) → approve → Microsoft callback → the client's code.
async function authorizeAndGetCode(client: ReturnType<typeof oauthClient>, authorizeUrl: URL): Promise<string> {
  const consent = await client.send(`${authorizeUrl.pathname}${authorizeUrl.search}`);
  expect(consent.status).toBe(200);
  const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1];
  const approved = await client.send("/authorize", client.form({ handle, decision: "approve" }));
  expect(approved.status).toBe(302);
  const msState = new URL(approved.headers.get("location")!).searchParams.get("state")!;
  const callback = await client.send(`/auth/microsoft/callback?code=ms-code&state=${encodeURIComponent(msState)}`);
  expect(callback.status).toBe(302);
  const to = new URL(callback.headers.get("location")!);
  expect(to.origin + to.pathname).toBe(REDIRECT_URI);
  return to.searchParams.get("code")!;
}

// Access not configured: nothing about it is visible.
export async function runAccessOffChecks(fetchFn: FetchFn, socket: (h: Headers) => Promise<boolean>) {
  const access = await stubAccess();
  const client = oauthClient(fetchFn);
  expect((await client.send("/app/signin")).status).toBe(404);
  expect((await client.send("/.well-known/apple-app-site-association")).status).toBe(404);
  const probe = await client.send("/api/v1/sync/info");
  expect(probe.status).toBe(200);
  const api = await client.connect(`${ORIGIN}/api/v1`);
  expect(api).not.toHaveProperty("cf_access_token");
  const bearer = { authorization: `Bearer ${api.access_token}` };
  expect((await client.send("/api/v1/sync/changes", { headers: bearer })).status).toBe(200);
  // An Access header is ignored, not checked: even a bad one changes nothing.
  expect((await client.send("/api/v1/sync/changes", { headers: { ...bearer, "cf-access-token": "junk" } })).status).toBe(200);
  expect(await socket(new Headers({ upgrade: "websocket", ...bearer }))).toBe(true);
  void access;
}

// Only one of the two variables set: every gated path fails closed.
export async function runAccessHalfConfiguredChecks(fetchFn: FetchFn, socket: (h: Headers) => Promise<boolean>) {
  const access = await stubAccess();
  const client = oauthClient(fetchFn);
  const good = { "cf-access-jwt-assertion": await access.good() };
  const probe = await client.send("/api/v1/sync/info", { headers: good });
  expect(probe.status).toBe(503);
  expect(await probe.json()).toEqual({ error: "access_misconfigured" });
  const api = await client.connect(`${ORIGIN}/api/v1`);
  const bearer = { authorization: `Bearer ${api.access_token}` };
  expect((await client.send("/api/v1/sync/changes", { headers: { ...bearer, ...good } })).status).toBe(503);
  expect((await client.send("/app/signin", { headers: good })).status).toBe(503);
  expect(await socket(new Headers({ upgrade: "websocket", ...bearer, ...good }))).toBe(false);
}
