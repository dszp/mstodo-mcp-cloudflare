import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { OWNER_DO_NAME } from "../src/core/index/sql";
import { seal, unseal, isSealed } from "../src/core/auth/crypto";
import {
  TOKENS_KEY,
  IDENTITY_KEY,
  SCOPES,
  loadTokens,
  storeTokens,
  reauthReasonFromTokenError,
  TokenExchangeError,
  type StoredTokens,
} from "../src/core/auth/microsoft";
import { parseClaimsChallenge, ReauthRequiredError, isReauthRequired } from "../src/core/auth/reauth";
import { grantRefusal, refuseMcpRequest, MAX_GRANT_AGE_MS } from "../src/core/auth/grant";
import { GraphClient } from "../src/core/graph/client";
import { consentPage } from "../src/hosts/cloudflare/consent-page";
import AuthHandler from "../src/hosts/cloudflare/auth-handler";
import type { Props } from "../src/core/types";
import { testAppEnv } from "./_app-env";
import type { AppEnv } from "../src/core/ports";

const E = testAppEnv();

function index() {
  return env.TODO_INDEX_DO.getByName(OWNER_DO_NAME);
}

const TOKENS: StoredTokens = {
  access_token: "at",
  refresh_token: "rt",
  expires_at: Date.now() + 3_600_000,
  scope: SCOPES,
  obtained_at: Date.now(),
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.TODO_CACHE.delete(TOKENS_KEY);
  await env.TODO_CACHE.delete(IDENTITY_KEY);
  await index().clearReauth();
});

describe("token sealing", () => {
  it("round-trips and binds the ciphertext to its key", async () => {
    const sealed = await seal(E, "secret", "k1");
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain("secret");
    expect(await unseal(E, sealed, "k1")).toBe("secret");
    await expect(unseal(E, sealed, "k2")).rejects.toThrow();
  });

  it("stores tokens sealed, never as plaintext JSON", async () => {
    // A long sentinel: a short token like "rt" turns up by chance in random
    // base64 ciphertext (~1 run in 10), which made this test flaky.
    const sentinel = "refresh-token-sentinel-6f2c9a41";
    const tokens = { ...TOKENS, refresh_token: sentinel };
    await storeTokens(E, tokens);
    const raw = (await env.TODO_CACHE.get(TOKENS_KEY))!;
    expect(isSealed(raw)).toBe(true);
    expect(raw).not.toContain(sentinel);
    expect(raw).not.toContain("refresh_token");
    expect(await loadTokens(E)).toEqual(tokens);
  });

  it("migrates a legacy plaintext record to sealed on first read", async () => {
    await env.TODO_CACHE.put(TOKENS_KEY, JSON.stringify(TOKENS));
    expect(await loadTokens(E)).toEqual(TOKENS);
    expect(isSealed((await env.TODO_CACHE.get(TOKENS_KEY))!)).toBe(true);
  });

  it("reads a record sealed under a different secret as no tokens", async () => {
    const other = { ...E, MS_CLIENT_SECRET: "rotated-secret" } as AppEnv;
    await storeTokens(other, TOKENS);
    expect(await loadTokens(E)).toBeNull();
  });
});

describe("parseClaimsChallenge", () => {
  const claims = '{"access_token":{"nbf":{"essential":true,"value":"1"}}}';
  it("decodes a CAE insufficient_claims challenge", () => {
    const res = new Response("", {
      status: 401,
      headers: {
        "www-authenticate": `Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", error="insufficient_claims", claims="${btoa(claims)}"`,
      },
    });
    expect(parseClaimsChallenge(res)).toBe(claims);
  });

  it("ignores an ordinary 401", () => {
    const res = new Response("", { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
    expect(parseClaimsChallenge(res)).toBeNull();
  });
});

describe("reauthReasonFromTokenError", () => {
  const err = (body: unknown) => new TokenExchangeError("microsoft_token_400", JSON.stringify(body));
  it("flags revoked grants and Conditional Access", () => {
    expect(reauthReasonFromTokenError(err({ error: "invalid_grant", error_codes: [50173] }))).toBe(
      "invalid_grant (AADSTS50173)",
    );
    expect(reauthReasonFromTokenError(err({ error: "interaction_required", error_codes: [53000] }))).toBe(
      "interaction_required (AADSTS53000)",
    );
  });

  it("leaves transient failures alone", () => {
    expect(reauthReasonFromTokenError(err({ error: "temporarily_unavailable" }))).toBeNull();
    expect(reauthReasonFromTokenError(new TokenExchangeError("microsoft_token_503", "<html>"))).toBeNull();
    expect(reauthReasonFromTokenError(new Error("network"))).toBeNull();
  });
});

describe("auth epoch and re-auth state (TodoIndex)", () => {
  it("keeps a stable epoch until revoked", async () => {
    const a = (await index().authState()).epoch;
    expect((await index().authState()).epoch).toBe(a);
    const b = await index().revokeAllGrants();
    expect(b).not.toBe(a);
    expect((await index().authState()).epoch).toBe(b);
  });

  it("an identity reset revokes every grant", async () => {
    const before = (await index().authState()).epoch;
    await index().resetIdentity();
    expect((await index().authState()).epoch).not.toBe(before);
  });

  it("a refused refresh marks re-auth required and stops the alarm loop", async () => {
    await storeTokens(E, { ...TOKENS, expires_at: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_codes: [50173] }), { status: 400 }),
      ),
    );
    const e = await index().refreshToken().then(() => null, (err: unknown) => err);
    expect(String(e)).toMatch(/reauth_required/);
    const { reauth } = await index().authState();
    expect(reauth?.reason).toBe("invalid_grant (AADSTS50173)");
  });

  it("a transient refresh failure does not", async () => {
    await storeTokens(E, { ...TOKENS, expires_at: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    const e = await index().refreshToken().then(() => null, (err: unknown) => err);
    expect(e).not.toBeNull();
    expect((await index().authState()).reauth).toBeNull();
  });
});

describe("grantRefusal", () => {
  it("refuses a grant with no epoch (issued before epochs existed)", async () => {
    expect(await grantRefusal(E, { user: "owner" })).toBe("grant_revoked");
    expect(await grantRefusal(E, undefined)).toBe("grant_revoked");
  });

  it("refuses a grant from an older epoch", async () => {
    const { epoch } = await index().authState();
    await index().revokeAllGrants();
    expect(await grantRefusal(E, { user: "owner", epoch, authorized_at: Date.now() })).toBe("grant_revoked");
  });

  it("refuses a grant past the maximum age", async () => {
    const { epoch } = await index().authState();
    const old = Date.now() - MAX_GRANT_AGE_MS - 1000;
    expect(await grantRefusal(E, { user: "owner", epoch, authorized_at: old })).toBe("grant_expired");
  });

  it("refuses while Microsoft re-auth is pending, then accepts", async () => {
    const { epoch } = await index().authState();
    const props = { user: "owner", epoch, authorized_at: Date.now() };
    await index().markReauthRequired("test");
    expect(await grantRefusal(E, props)).toBe("reauth_required");
    await index().clearReauth();
    expect(await grantRefusal(E, props)).toBeNull();
  });
});

describe("refuseMcpRequest (HTTP-layer gate)", () => {
  it("answers 401 invalid_token for a revoked grant so the client re-authorizes", async () => {
    const { epoch } = await index().authState();
    await index().revokeAllGrants();
    const res = await refuseMcpRequest(E, { user: "owner", epoch, authorized_at: Date.now() });
    expect(res?.status).toBe(401);
    expect(res?.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
  });

  it("lets a current grant through", async () => {
    const { epoch } = await index().authState();
    expect(await refuseMcpRequest(E, { user: "owner", epoch, authorized_at: Date.now() })).toBeNull();
  });
});

describe("Exchange-only refusal", () => {
  it("disables My Day without locking the whole server", async () => {
    await storeTokens(E, TOKENS);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "interaction_required", error_codes: [53000] }), { status: 400 }),
      ),
    );
    const e = await index().forceSubstrateRefresh().then(() => null, (err: unknown) => err);
    expect(String(e)).toMatch(/my_day_unavailable/);
    expect((await index().authState()).reauth).toBeNull();
  });
});

describe("GraphClient claims challenge", () => {
  it("reports the challenge and does not refresh-and-retry", async () => {
    const claims = '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}';
    const fetchSpy = vi.fn(
      async () =>
        new Response("", {
          status: 401,
          headers: { "www-authenticate": `Bearer error="insufficient_claims", claims="${btoa(claims)}"` },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const forceRefresh = vi.fn(async () => "at2");
    const reportClaimsChallenge = vi.fn(async () => undefined);
    const graph = new GraphClient({ getAccessToken: async () => "at", forceRefresh, reportClaimsChallenge });
    const p = graph.deleteResource("https://graph.microsoft.com/v1.0/me/todo/lists/x");
    await expect(p).rejects.toBeInstanceOf(ReauthRequiredError);
    await p.catch((e) => expect(isReauthRequired(e)).toBe(true));
    expect(reportClaimsChallenge).toHaveBeenCalledWith(claims);
    expect(forceRefresh).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("consent page", () => {
  it("escapes everything that came from client registration", () => {
    const html = consentPage(
      {
        clientId: "c1",
        clientName: '<script>alert(1)</script>"',
        redirectUri: 'https://evil.example/cb?x="><img src=x>',
        redirectHost: "evil.example",
        redirectIsLoopback: false,
        scope: [],
      },
      'h"1',
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('value="h&quot;1"');
    expect(html).toContain("evil.example");
  });
});

// The handler against a scripted OAUTH_PROVIDER: what matters is the ORDER —
// nothing reaches Microsoft until the owner approves the client.
describe("authorize flow", () => {
  const authRequest = {
    responseType: "code",
    clientId: "client-1",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    scope: [],
    state: "client-state",
  };
  let calls: string[];
  let remembered: boolean;

  function oauthStub() {
    return {
      parseAuthRequest: vi.fn(async () => (calls.push("parse"), authRequest)),
      isConsentRemembered: vi.fn(async () => (calls.push("remembered?"), remembered)),
      describeConsent: vi.fn(async () => ({
        clientId: "client-1",
        clientName: "Claude",
        redirectUri: authRequest.redirectUri,
        redirectHost: "claude.ai",
        redirectIsLoopback: false,
        scope: [],
      })),
      beginConsent: vi.fn(async () => (calls.push("beginConsent"), { handle: "h1", headers: new Headers() })),
      approveConsent: vi.fn(async () => (calls.push("approve"), { request: authRequest, headers: new Headers() })),
      denyConsent: vi.fn(async () => {
        calls.push("deny");
        return {
          request: authRequest,
          redirectTo: "https://claude.ai/cb?error=access_denied",
          headers: new Headers({ location: "https://claude.ai/cb?error=access_denied" }),
        };
      }),
      beginUpstream: vi.fn(async () => (calls.push("beginUpstream"), { state: "ms-state", headers: new Headers() })),
      finishUpstream: vi.fn(async () => ({ request: authRequest, data: { verifier: "v".repeat(43) }, headers: new Headers() })),
      completeAuthorization: vi.fn(async () => ({ redirectTo: "https://claude.ai/cb?code=abc" })),
    };
  }

  let oauth: ReturnType<typeof oauthStub>;
  const envWith = () => ({ ...(env as object), OAUTH_PROVIDER: oauth }) as unknown as Env;

  beforeEach(() => {
    calls = [];
    remembered = false;
    oauth = oauthStub();
  });

  it("shows the consent page and does not start Microsoft sign-in", async () => {
    const res = await AuthHandler.fetch(new Request("https://mcp.test/authorize?client_id=client-1"), envWith());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Allow Claude to use your Microsoft To&nbsp;Do?");
    expect(calls).not.toContain("beginUpstream");
  });

  function post(decision: string, remember = true) {
    const body = new URLSearchParams({ handle: "h1", decision, ...(remember ? { remember: "1" } : {}) });
    return new Request("https://mcp.test/authorize", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }

  it("starts Microsoft sign-in only after approval", async () => {
    const res = await AuthHandler.fetch(post("approve"), envWith());
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://login.microsoftonline.com/test-tenant/oauth2/v2.0/authorize");
    expect(loc.searchParams.get("state")).toBe("ms-state");
    expect(calls).toEqual(["approve", "beginUpstream"]);
    expect((oauth.approveConsent.mock.calls[0] as unknown[])[2]).toHaveProperty("remember");
  });

  it("sends a denial back to the client without touching Microsoft", async () => {
    const res = await AuthHandler.fetch(post("deny"), envWith());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=access_denied");
    expect(calls).toEqual(["deny"]);
  });

  it("skips the page for a client this browser already approved", async () => {
    remembered = true;
    const res = await AuthHandler.fetch(new Request("https://mcp.test/authorize?client_id=client-1"), envWith());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/login\.microsoftonline\.com\//);
    expect(calls).toEqual(["parse", "remembered?", "beginUpstream"]);
  });

  it("passes a pending claims challenge to Microsoft", async () => {
    await index().markReauthRequired("claims_challenge", '{"access_token":{}}');
    const res = await AuthHandler.fetch(post("approve"), envWith());
    expect(new URL(res.headers.get("location")!).searchParams.get("claims")).toBe('{"access_token":{}}');
  });

  function stubMicrosoft(mail: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/oauth2/v2.0/token")) {
          return new Response(
            JSON.stringify({ token_type: "Bearer", scope: SCOPES, expires_in: 3600, access_token: "a.e30.s", refresh_token: "rt" }),
          );
        }
        if (url === "https://graph.microsoft.com/v1.0/me") {
          return new Response(JSON.stringify({ id: "me-1", displayName: "Owner", mail, userPrincipalName: mail }));
        }
        return new Response("unscripted", { status: 404 });
      }),
    );
  }

  it("issues a grant stamped with the current epoch and clears re-auth", async () => {
    stubMicrosoft("test-owner@example.com");
    await index().markReauthRequired("test");
    const res = await AuthHandler.fetch(new Request("https://mcp.test/auth/microsoft/callback?code=c&state=s"), envWith());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://claude.ai/cb?code=abc");
    const [opts] = oauth.completeAuthorization.mock.calls[0] as unknown as [{ props: Props }];
    const props = opts.props;
    const { epoch, reauth } = await index().authState();
    expect(props.epoch).toBe(epoch);
    expect(typeof props.authorized_at).toBe("number");
    expect(reauth).toBeNull();
    expect(await grantRefusal(E, props)).toBeNull();
  });

  it("sends a Microsoft-side error back to the client as access_denied", async () => {
    const res = await AuthHandler.fetch(
      new Request("https://mcp.test/auth/microsoft/callback?error=access_denied&error_description=cancelled&state=s"),
      envWith(),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("client-state");
  });

  it("refuses an oversized consent form without buffering it", async () => {
    const res = await AuthHandler.fetch(
      new Request("https://mcp.test/authorize", { method: "POST", body: "handle=h1&pad=" + "x".repeat(10_000) }),
      envWith(),
    );
    expect(res.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("refuses a non-owner before storing anything", async () => {
    stubMicrosoft("someone-else@example.com");
    const res = await AuthHandler.fetch(new Request("https://mcp.test/auth/microsoft/callback?code=c&state=s"), envWith());
    expect(res.status).toBe(403);
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
    expect(await env.TODO_CACHE.get(TOKENS_KEY)).toBeNull();
  });
});
