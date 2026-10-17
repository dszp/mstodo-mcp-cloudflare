import { expect, vi } from "vitest";
import { SCOPES } from "../src/core/auth/microsoft";

// A browser + MCP client driving the OAuth front (DCR → consent → Microsoft
// callback → /token) through any fetch function, with a cookie jar. Shared by
// the Task 9 spike (provider.fetch directly) and the Node host tests (the full
// createHandler routing).

export const ORIGIN = "https://mcp.test"; // https: the library's __Host- cookies are Secure
export const REDIRECT_URI = "http://localhost:9/cb";

// Microsoft's token endpoint and Graph /me, scripted. `extra` answers any other
// URL first (return undefined to fall through to the 404).
export function stubMicrosoft(mail: string, extra?: (url: string) => Response | undefined) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    const scripted = extra?.(url);
    if (scripted) return scripted;
    if (url.endsWith("/oauth2/v2.0/token")) {
      return new Response(
        JSON.stringify({ token_type: "Bearer", scope: SCOPES, expires_in: 3600, access_token: "a.e30.s", refresh_token: "rt" }),
      );
    }
    if (url === "https://graph.microsoft.com/v1.0/me") {
      return new Response(JSON.stringify({ id: "me-1", displayName: "Owner", mail, userPrincipalName: mail }));
    }
    return new Response("unscripted", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

export function oauthClient(fetchFn: (req: Request) => Promise<Response>, origin = ORIGIN) {
  const jar = new Map<string, string>();
  async function send(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetchFn(new Request(`${origin}${path}`, { ...init, headers }));
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      if (/max-age=0/i.test(attrs.join(";"))) jar.delete(name);
      else jar.set(name, pair.slice(i + 1));
    }
    return res;
  }
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

  // DCR → GET /authorize (consent) → POST approve → Microsoft callback.
  async function authorizeThroughCallback() {
    const reg = await send("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", client_name: "Spike" }),
    });
    expect(reg.status).toBe(201);
    const { client_id: clientId } = (await reg.json()) as { client_id: string };

    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: "client-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${origin}/mcp`,
    });
    const consent = await send(`/authorize?${q}`);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain("Allow Spike to use your Microsoft To&nbsp;Do?");
    expect([...jar.keys()].some((k) => k.startsWith("__Host-"))).toBe(true);
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1];

    const approved = await send("/authorize", form({ handle, decision: "approve" }));
    expect(approved.status).toBe(302);
    const ms = new URL(approved.headers.get("location")!);
    expect(ms.origin + ms.pathname).toBe("https://login.microsoftonline.com/test-tenant/oauth2/v2.0/authorize");
    expect(ms.searchParams.get("redirect_uri")).toBe(`${origin}/auth/microsoft/callback`);
    const msState = ms.searchParams.get("state")!;

    const callback = await send(`/auth/microsoft/callback?code=ms-code&state=${encodeURIComponent(msState)}`);
    return { callback, clientId, verifier };
  }

  // The whole flow, ending with the MCP client's tokens.
  async function connect() {
    const { callback, clientId, verifier } = await authorizeThroughCallback();
    expect(callback.status).toBe(302);
    const code = new URL(callback.headers.get("location")!).searchParams.get("code")!;
    const tok = await send(
      "/token",
      form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
    );
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string; refresh_token: string };
    return { ...t, clientId };
  }

  return { send, form, authorizeThroughCallback, connect };
}
