// A stand-in for potem-server's OAuth front, for BFF tests. Each behaviour
// copies the real one; the comments name where it comes from. "the library" is
// node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js (1.2.3).

type Client = { secret: string; redirect_uris: string[]; client_name: string };
type Code = { client_id: string; redirect_uri: string; challenge: string; cf_access?: boolean };
type Grant = { client_id: string; refresh_token: string; previous_refresh_token?: string; revoked: boolean };

/** How the anonymous /api/v1/sync/info probe answers. */
export type AccessMode = "off" | "redirect" | "forbidden";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function randomId(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function s256(verifier: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let bin = "";
  for (const x of hash) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const CF_ACCESS_TOKEN = "cf-access-jwt-for-tests";
export const CF_ACCESS_EXPIRES_AT = 1_900_000_000;

export class TestServer {
  readonly clients = new Map<string, Client>();
  readonly grants: Grant[] = [];
  readonly registrations: unknown[] = [];
  readonly tokenRequests: { headers: Headers; form: URLSearchParams }[] = [];
  /** Authenticated /api/v1 requests: path with query, and headers. */
  readonly apiRequests: { path: string; headers: Headers }[] = [];
  /** When set, answers authenticated /api/v1 requests instead of the default JSON echo. */
  apiReply: ((req: Request) => Response | Promise<Response>) | null = null;
  /** The next this-many refresh grants answer invalid_grant, as for a superseded token. */
  refreshRefusals = 0;
  access: AccessMode = "off";
  /** When set, /token answers with this status and an empty body. */
  tokenFailure: number | null = null;
  /** When set, the anonymous /api/v1/sync/info probe answers with this status. */
  probeFailure: number | null = null;
  /** When set, replaces the cf_access_token in a token response. */
  cfAccessTokenOverride: string | null = null;
  /** When set, /register answers with this status. */
  registerFailure: number | null = null;
  #codes = new Map<string, Code>();
  /** Issued access tokens and the grant each belongs to. */
  #accessTokens = new Map<string, Grant>();

  constructor(readonly origin: string) {}

  liveGrants(clientId?: string): Grant[] {
    return this.grants.filter((g) => !g.revoked && (clientId === undefined || g.client_id === clientId));
  }

  deleteClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.origin !== this.origin) return new Response("wrong origin", { status: 421 });
    if (url.pathname === "/register" && req.method === "POST") return this.#register(req);
    if (url.pathname === "/token" && req.method === "POST") return this.#token(req);
    if (url.pathname === "/api/v1/sync/info" && req.method === "GET" && !req.headers.has("authorization")) {
      return this.#probe();
    }
    if (url.pathname.startsWith("/api/v1/")) return this.#api(req, url);
    return new Response("not found", { status: 404 });
  }

  /**
   * What the browser goes through between the BFF's redirect and its callback:
   * /app/signin (when Access is on), /authorize, consent, Microsoft. Returns the
   * callback URL the server redirects to, like completeAuthorization.
   */
  async authorize(location: string): Promise<string> {
    const url = new URL(location);
    const q = url.searchParams;
    let viaSignin = false;
    if (url.pathname === "/app/signin") {
      // app-signin.ts handleAppSignin: off → 404; otherwise these checks.
      if (this.access === "off") throw new Error("/app/signin is a 404 when Access is off");
      if (
        q.get("response_type") !== "code" ||
        !q.get("client_id") ||
        !q.get("redirect_uri") ||
        !q.get("code_challenge") ||
        q.get("code_challenge_method") !== "S256" ||
        q.get("resource") !== `${this.origin}/api/v1`
      ) {
        throw new Error("/app/signin: invalid sign-in request");
      }
      viaSignin = true;
    } else if (url.pathname !== "/authorize") {
      throw new Error(`unexpected authorization path ${url.pathname}`);
    }
    if (url.origin !== this.origin) throw new Error("authorization sent to another origin");
    // The library's parseAuthRequest: client and exact redirect URI first; an
    // unknown client is an error page on the server, never a redirect.
    const client = this.clients.get(q.get("client_id") ?? "");
    if (!client) throw new Error("Invalid client_id");
    const redirectUri = q.get("redirect_uri") ?? "";
    if (!client.redirect_uris.includes(redirectUri)) throw new Error("Invalid redirect URI");
    for (const p of ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "resource"]) {
      if (q.getAll(p).length !== 1) throw new Error(`parameter ${p} must appear once`);
    }
    if (q.get("response_type") !== "code") throw new Error("unsupported response_type");
    if (q.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 required");
    if (q.get("resource") !== `${this.origin}/api/v1`) throw new Error("wrong resource");

    // completeAuthorization (auth-handler.ts) runs without
    // revokeExistingGrants: false, so the client's earlier grants end.
    const clientId = q.get("client_id")!;
    for (const g of this.grants) if (g.client_id === clientId) g.revoked = true;
    const code = `code-${randomId()}`;
    this.#codes.set(code, {
      client_id: clientId,
      redirect_uri: redirectUri,
      challenge: q.get("code_challenge")!,
      cf_access: viaSignin,
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state") ?? "");
    return back.toString();
  }

  // The library's handleClientRegistration: 201, and a client_secret for any
  // auth method but "none".
  async #register(req: Request): Promise<Response> {
    if (this.registerFailure) return new Response("unavailable", { status: this.registerFailure });
    const body = (await req.json()) as Record<string, unknown>;
    this.registrations.push(body);
    const method = (body.token_endpoint_auth_method as string | undefined) ?? "client_secret_basic";
    const client_id = randomId(8);
    const secret = method === "none" ? "" : randomId(16);
    this.clients.set(client_id, {
      secret,
      redirect_uris: body.redirect_uris as string[],
      client_name: body.client_name as string,
    });
    return json(
      {
        client_id,
        redirect_uris: body.redirect_uris,
        client_name: body.client_name,
        grant_types: body.grant_types,
        token_endpoint_auth_method: method,
        client_id_issued_at: 1_800_000_000,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0, client_secret_issued_at: 1_800_000_000 } : {}),
      },
      201,
    );
  }

  // The library's parseTokenEndpointRequest, then revokeToken or the
  // authorization-code grant.
  async #token(req: Request): Promise<Response> {
    if ((req.headers.get("content-type") ?? "").split(";")[0].trim() !== "application/x-www-form-urlencoded") {
      return json({ error: "invalid_request", error_description: "Content-Type must be application/x-www-form-urlencoded" }, 400);
    }
    const form = new URLSearchParams(await req.text());
    this.tokenRequests.push({ headers: new Headers(req.headers), form });
    if (this.tokenFailure) return new Response("", { status: this.tokenFailure });

    const invalidClient = (description: string) =>
      json({ error: "invalid_client", error_description: description }, 401, { "www-authenticate": 'Basic realm="OAuth"' });
    const m = /^Basic (\S+)$/.exec(req.headers.get("authorization") ?? "");
    if (!m) return invalidClient("Client ID is required");
    const decoded = atob(m[1]);
    const sep = decoded.indexOf(":");
    const dec = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
    const clientId = dec(decoded.slice(0, sep));
    const secret = dec(decoded.slice(sep + 1));
    const client = this.clients.get(clientId);
    if (!client) return invalidClient("Client not found");
    if (client.secret !== secret) return invalidClient("Client authentication failed: invalid client_secret");

    // RFC 7009 revocation: a token and no grant_type, after the client checks
    // above (a dead client is 401 invalid_client, like the library's
    // parseTokenEndpointRequest, lines 3189 and 3217). Then always 200, revoking only
    // a token that belongs to this client; a token that isn't three ":"-parts
    // is answered 200 without a lookup (revokeToken, lines 4255-4256).
    if (!form.get("grant_type") && form.get("token")) {
      const grant = this.grants.find((g) => g.refresh_token === form.get("token") && g.client_id === clientId);
      if (grant) grant.revoked = true;
      return new Response("", { status: 200 });
    }
    if (form.get("grant_type") === "refresh_token") return this.#refresh(form, clientId);
    if (form.get("grant_type") !== "authorization_code") {
      return json({ error: "unsupported_grant_type", error_description: "Grant type not supported" }, 400);
    }
    const code = this.#codes.get(form.get("code") ?? "");
    if (!code) return json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400);
    this.#codes.delete(form.get("code")!);
    if (code.client_id !== clientId) return json({ error: "invalid_grant", error_description: "Client ID mismatch" }, 400);
    if (form.get("redirect_uri") && form.get("redirect_uri") !== code.redirect_uri) {
      return json({ error: "invalid_grant", error_description: "redirect_uri does not match the authorization request" }, 400);
    }
    if ((await s256(form.get("code_verifier") ?? "")) !== code.challenge) {
      return json({ error: "invalid_grant", error_description: "Invalid PKCE code_verifier" }, 400);
    }
    const refresh_token = `refresh-${randomId()}`;
    const grant: Grant = { client_id: clientId, refresh_token, revoked: false };
    this.grants.push(grant);
    return json({
      access_token: this.#issueAccess(grant),
      token_type: "bearer",
      expires_in: 3600,
      scope: "",
      resource: `${this.origin}/api/v1`,
      refresh_token,
      // oauth.ts adds these (app-signin.ts withAccessToken) when the grant
      // started at /app/signin.
      ...(code.cf_access ? { cf_access_token: this.cfAccessTokenOverride ?? CF_ACCESS_TOKEN, cf_access_expires_at: CF_ACCESS_EXPIRES_AT } : {}),
    });
  }

  #issueAccess(grant: Grant): string {
    const token = `access-${randomId()}`;
    this.#accessTokens.set(token, grant);
    return token;
  }

  // The library's handleRefreshTokenGrant (lines 3668-3826), after the client
  // checks in #token. The presented token may be the grant's current one or the
  // one it replaced (isPreviousToken, line 3688): that is the grace window
  // that lets two refreshes racing with the same token both succeed. Anything
  // else is invalid_grant "Invalid refresh token" (line 3689); a revoked grant
  // is gone from KV, "Grant not found" (line 3683). Every success rotates: the
  // presented token becomes the previous one and a new one is issued (lines
  // 3789-3795), and the response always carries it (line 3823). No
  // cf_access_token: the OAuth front adds one only when the token callback
  // filled the handoff slot, which it does for authorization_code alone
  // (workers/server/src/hosts/shared/oauth.ts, lines 94-98 and 234-239).
  #refresh(form: URLSearchParams, clientId: string): Response {
    const presented = form.get("refresh_token");
    if (!presented) return json({ error: "invalid_request", error_description: "Refresh token is required" }, 400);
    if (this.refreshRefusals > 0) {
      this.refreshRefusals--;
      return json({ error: "invalid_grant", error_description: "Invalid refresh token" }, 400);
    }
    const grant = this.grants.find((g) => g.refresh_token === presented || g.previous_refresh_token === presented);
    if (!grant || grant.revoked) return json({ error: "invalid_grant", error_description: "Grant not found" }, 400);
    if (grant.client_id !== clientId) return json({ error: "invalid_grant", error_description: "Client ID mismatch" }, 400);
    grant.previous_refresh_token = presented;
    grant.refresh_token = `refresh-${randomId()}`;
    return json({
      access_token: this.#issueAccess(grant),
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: grant.refresh_token,
      scope: "",
      resource: `${this.origin}/api/v1`,
    });
  }

  // The resource server: an unknown or revoked bearer token is 401
  // invalid_token with a Bearer challenge (the library's validation in
  // oauth-provider.js, lines 4491-4494).
  async #api(req: Request, url: URL): Promise<Response> {
    const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
    const grant = m ? this.#accessTokens.get(m[1]) : undefined;
    if (!grant || grant.revoked) {
      return json({ error: "invalid_token", error_description: "Invalid access token" }, 401, {
        "www-authenticate": 'Bearer error="invalid_token"',
      });
    }
    this.apiRequests.push({ path: url.pathname + url.search, headers: new Headers(req.headers) });
    if (this.apiReply) return this.apiReply(req);
    return json({ path: url.pathname, search: url.search });
  }

  #probe(): Response {
    if (this.probeFailure) return json({ error: "access_unavailable" }, this.probeFailure);
    if (this.access === "redirect") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/server.example.com" },
      });
    }
    if (this.access === "forbidden") return json({ error: "access_denied" }, 403);
    return json({ server_id: "test-server-id" });
  }
}
