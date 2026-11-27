import { beforeEach, describe, expect, it } from "vitest";
import { handleCallback, handleLogin, handleLogout } from "./auth.ts";
import { DEVICE_COOKIE, LOGIN_COOKIE, SESSION_COOKIE } from "./cookies.ts";
import { sealer } from "./seal.ts";
import type { Device, Session } from "./session.ts";
import { CF_ACCESS_EXPIRES_AT, CF_ACCESS_TOKEN, TestServer } from "./test-server.ts";
import { type BffConfig, basicAuth, upstreamVia } from "./upstream.ts";

const WEB = "https://web.example.com";
const SERVER = "https://server.example.com";
const SECRET = "test-secret-test-secret-test-secret-0123";
const NOW = 1_800_000_000;

let server: TestServer;
let cfg: BffConfig;

beforeEach(() => {
  server = new TestServer(SERVER);
  cfg = {
    webOrigin: WEB,
    serverOrigin: SERVER,
    secret: SECRET,
    maxHours: 12,
    idleMinutes: 60,
    upstream: upstreamVia(SERVER, (r) => server.fetch(r)),
    now: () => NOW,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  };
});

/** One browser's cookies: stores Set-Cookie, sends Cookie. */
class Jar {
  readonly values = new Map<string, string>();
  store(res: Response): Response {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith("max-age="));
      if (maxAge && Number(maxAge.split("=")[1]) <= 0) this.values.delete(name);
      else this.values.set(name, pair.slice(eq + 1));
    }
    return res;
  }
  header(): string {
    return [...this.values].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  request(url: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    if (this.values.size) headers.set("cookie", this.header());
    return new Request(new URL(url, WEB), { ...init, headers });
  }
  async login(returnTo?: string): Promise<Response> {
    const q = returnTo === undefined ? "" : `?return_to=${encodeURIComponent(returnTo)}`;
    return this.store(await handleLogin(this.request(`/auth/login${q}`), cfg));
  }
  async callback(url: string): Promise<Response> {
    return this.store(await handleCallback(this.request(url), cfg));
  }
  async logout(headers: Record<string, string> = { "x-potem": "1", origin: WEB }): Promise<Response> {
    return this.store(await handleLogout(this.request("/auth/logout", { method: "POST", headers }), cfg));
  }
  /** Login, the server's pages, and the callback. */
  async signIn(returnTo?: string): Promise<Response> {
    const res = await this.login(returnTo);
    expect(res.status).toBe(302);
    return this.callback(await server.authorize(res.headers.get("location")!));
  }
  async unseal<T>(name: string): Promise<T | null> {
    const v = this.values.get(name);
    return v ? (await sealer(SECRET)).unseal<T>(name, v) : null;
  }
}

async function s256(verifier: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...hash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Login = { state: string; verifier: string; return_to: string; access: boolean; client_id: string; retry?: boolean };

describe("GET /auth/login", () => {
  it("registers a client on first login and reuses it on the second", async () => {
    const jar = new Jar();
    await jar.login();
    expect(server.registrations).toEqual([
      {
        client_name: "Potem Web",
        redirect_uris: [`${WEB}/auth/callback`],
        token_endpoint_auth_method: "client_secret_basic",
        grant_types: ["authorization_code", "refresh_token"],
      },
    ]);
    const device = await jar.unseal<Device>(DEVICE_COOKIE);
    expect(device?.server_origin).toBe(SERVER);
    expect(server.clients.has(device!.client_id)).toBe(true);

    await jar.login();
    expect(server.registrations).toHaveLength(1);
    expect((await jar.unseal<Device>(DEVICE_COOKIE))?.client_id).toBe(device!.client_id);
  });

  it("sets long-lived device and ten-minute login cookies with the __Host- attributes", async () => {
    const res = await new Jar().login();
    const lines = res.headers.getSetCookie();
    const device = lines.find((l) => l.startsWith(`${DEVICE_COOKIE}=`))!;
    const login = lines.find((l) => l.startsWith(`${LOGIN_COOKIE}=`))!;
    for (const l of [device, login]) {
      for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) expect(l).toContain(attr);
    }
    expect(device).toContain(`Max-Age=${400 * 86400}`);
    expect(login).toContain("Max-Age=600");
  });

  it("redirects to /authorize with every parameter, each once", async () => {
    const jar = new Jar();
    const res = await jar.login("/list/abc?task=1");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe(SERVER);
    expect(loc.pathname).toBe("/authorize");
    const q = loc.searchParams;
    const login = (await jar.unseal<Login>(LOGIN_COOKIE))!;
    const device = (await jar.unseal<Device>(DEVICE_COOKIE))!;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(device.client_id);
    expect(q.get("redirect_uri")).toBe(`${WEB}/auth/callback`);
    expect(q.get("state")).toBe(login.state);
    expect(q.get("code_challenge")).toBe(await s256(login.verifier));
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("resource")).toBe(`${SERVER}/api/v1`);
    expect([...new Set(q.keys())].sort()).toEqual(
      ["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "resource", "response_type", "state"],
    );
    for (const k of q.keys()) expect(q.getAll(k)).toHaveLength(1);
    expect(login.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(login.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(login.state).not.toBe(login.verifier);
    expect(login.return_to).toBe("/list/abc?task=1");
    expect(login.access).toBe(false);
    expect(login.client_id).toBe(device.client_id);
  });

  for (const mode of ["redirect", "forbidden"] as const) {
    it(`sends login to /app/signin when the probe shows Access (${mode})`, async () => {
      server.access = mode;
      const jar = new Jar();
      const res = await jar.login();
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin).toBe(SERVER);
      expect(loc.pathname).toBe("/app/signin");
      expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
      expect(loc.searchParams.get("resource")).toBe(`${SERVER}/api/v1`);
      expect((await jar.unseal<Login>(LOGIN_COOKIE))?.access).toBe(true);
    });
  }

  for (const bad of ["//evil.example", "https://evil.example", "/\\evil", "\\evil", "evil"]) {
    it(`falls back to / for return_to ${JSON.stringify(bad)}`, async () => {
      const jar = new Jar();
      await jar.login(bad);
      expect((await jar.unseal<Login>(LOGIN_COOKIE))?.return_to).toBe("/");
    });
  }

  it("treats a device cookie sealed for another server as absent", async () => {
    const jar = new Jar();
    const s = await sealer(SECRET);
    jar.values.set(
      DEVICE_COOKIE,
      await s.seal(DEVICE_COOKIE, { client_id: "other", client_secret: "x", server_origin: "https://other.example.com" }),
    );
    await jar.login();
    expect(server.registrations).toHaveLength(1);
    expect((await jar.unseal<Device>(DEVICE_COOKIE))?.server_origin).toBe(SERVER);
  });

  it("treats a malformed device record as absent", async () => {
    const jar = new Jar();
    const s = await sealer(SECRET);
    jar.values.set(DEVICE_COOKIE, await s.seal(DEVICE_COOKIE, { client_id: "only" }));
    await jar.login();
    expect(server.registrations).toHaveLength(1);
  });

  it("shows a 502 page and sets no cookie when registration fails", async () => {
    server.registerFailure = 503;
    const res = await new Jar().login();
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('href="/auth/login"');
    const set = res.headers.getSetCookie();
    expect(set.every((l) => l.startsWith(`${LOGIN_COOKIE}=;`))).toBe(true);
  });

  it("shows a 502 page when the server can't be reached", async () => {
    cfg.upstream = async () => {
      throw new TypeError("fetch failed");
    };
    const res = await new Jar().login();
    expect(res.status).toBe(502);
  });
});

describe("GET /auth/callback", () => {
  it("creates the session, clears the login cookie and returns to return_to", async () => {
    const jar = new Jar();
    const res = await jar.signIn("/smart/today");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${WEB}/smart/today`);
    expect(jar.values.has(LOGIN_COOKIE)).toBe(false);
    const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`))!;
    expect(line).toContain(`Max-Age=${12 * 3600}`);
    const s = (await jar.unseal<Session>(SESSION_COOKIE))!;
    const grant = server.liveGrants()[0];
    expect(s.refresh_token).toBe(grant.refresh_token);
    expect(s.access_token).toMatch(/^access-/);
    expect(s.access_exp).toBe(NOW + 3600);
    expect(s.created_at).toBe(NOW);
    expect(s.last_seen).toBe(NOW);
    expect(s.data_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.cf_access_token).toBeUndefined();
    expect(s.cf_access_exp).toBeUndefined();
  });

  it("authenticates the code exchange with HTTP Basic and sends the verifier and redirect URI", async () => {
    const jar = new Jar();
    const res = await jar.login();
    const login = (await jar.unseal<Login>(LOGIN_COOKIE))!;
    const device = (await jar.unseal<Device>(DEVICE_COOKIE))!;
    await jar.callback(await server.authorize(res.headers.get("location")!));
    const req = server.tokenRequests.at(-1)!;
    expect(req.headers.get("authorization")).toBe(`Basic ${btoa(`${device.client_id}:${device.client_secret}`)}`);
    expect(req.form.get("grant_type")).toBe("authorization_code");
    expect(req.form.get("code_verifier")).toBe(login.verifier);
    expect(req.form.get("redirect_uri")).toBe(`${WEB}/auth/callback`);
    expect(req.form.has("client_id")).toBe(false);
    expect(req.form.has("client_secret")).toBe(false);
  });

  it("gives each data_key fresh random bytes", async () => {
    const a = new Jar();
    const b = new Jar();
    await a.signIn();
    await b.signIn();
    expect((await a.unseal<Session>(SESSION_COOKIE))!.data_key).not.toBe((await b.unseal<Session>(SESSION_COOKIE))!.data_key);
  });

  it("two browsers keep separate grants", async () => {
    const laptop = new Jar();
    const phone = new Jar();
    await laptop.signIn();
    await phone.signIn();
    const laptopClient = (await laptop.unseal<Device>(DEVICE_COOKIE))!.client_id;
    const phoneClient = (await phone.unseal<Device>(DEVICE_COOKIE))!.client_id;
    expect(laptopClient).not.toBe(phoneClient);
    // The server revokes a client's earlier grants on a new authorization; the
    // laptop's grant survives the phone's sign-in only because it's another client.
    expect(server.liveGrants(laptopClient).map((g) => g.refresh_token)).toEqual([
      (await laptop.unseal<Session>(SESSION_COOKIE))!.refresh_token,
    ]);
    expect(server.liveGrants(phoneClient)).toHaveLength(1);
  });

  it("carries cf_access_token and cf_access_expires_at into the session", async () => {
    server.access = "forbidden";
    const jar = new Jar();
    await jar.signIn();
    const s = (await jar.unseal<Session>(SESSION_COOKIE))!;
    expect(s.cf_access_token).toBe(CF_ACCESS_TOKEN);
    // app-signin.ts sends seconds since the epoch, the session's unit too.
    expect(s.cf_access_exp).toBe(CF_ACCESS_EXPIRES_AT);
  });

  it("refuses a state that doesn't match the login cookie: 400, no session, no code exchange", async () => {
    const jar = new Jar();
    const res = await jar.login();
    const cb = new URL(await server.authorize(res.headers.get("location")!));
    cb.searchParams.set("state", "forged");
    const out = await jar.callback(cb.toString());
    expect(out.status).toBe(400);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
    expect(server.tokenRequests).toHaveLength(0);
  });

  it("refuses a callback without a login cookie", async () => {
    const jar = new Jar();
    const res = await jar.login();
    const cb = await server.authorize(res.headers.get("location")!);
    jar.values.delete(LOGIN_COOKIE);
    const out = await jar.callback(cb);
    expect(out.status).toBe(400);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
    expect(server.tokenRequests).toHaveLength(0);
  });

  it("refuses a callback when the device cookie changed since login", async () => {
    const jar = new Jar();
    const res = await jar.login();
    const cb = await server.authorize(res.headers.get("location")!);
    const other = new Jar();
    await other.login();
    jar.values.set(DEVICE_COOKIE, other.values.get(DEVICE_COOKIE)!);
    const out = await jar.callback(cb);
    expect(out.status).toBe(400);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
    expect(server.tokenRequests).toHaveLength(0);
  });

  it("registers again once when the server answers invalid_client", async () => {
    const jar = new Jar();
    const res = await jar.login("/list/x");
    const first = (await jar.unseal<Device>(DEVICE_COOKIE))!.client_id;
    const cb = await server.authorize(res.headers.get("location")!);
    server.deleteClient(first);

    const out = await jar.callback(cb);
    expect(out.status).toBe(302);
    const again = new URL(out.headers.get("location")!);
    expect(again.origin).toBe(WEB);
    expect(again.pathname).toBe("/auth/login");
    expect(again.searchParams.get("return_to")).toBe("/list/x");
    expect(jar.values.has(DEVICE_COOKIE)).toBe(false);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);

    const relogin = await jar.store(await handleLogin(jar.request(again.pathname + again.search), cfg));
    expect(server.registrations).toHaveLength(2);
    const second = (await jar.unseal<Device>(DEVICE_COOKIE))!.client_id;
    expect(second).not.toBe(first);
    const done = await jar.callback(await server.authorize(relogin.headers.get("location")!));
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${WEB}/list/x`);
    expect(jar.values.has(SESSION_COOKIE)).toBe(true);
  });

  it("shows the error page on a second invalid_client instead of looping", async () => {
    const jar = new Jar();
    let res = await jar.login();
    let cb = await server.authorize(res.headers.get("location")!);
    server.deleteClient((await jar.unseal<Device>(DEVICE_COOKIE))!.client_id);
    const out = await jar.callback(cb);
    const again = new URL(out.headers.get("location")!);

    res = await jar.store(await handleLogin(jar.request(again.pathname + again.search), cfg));
    cb = await server.authorize(res.headers.get("location")!);
    server.deleteClient((await jar.unseal<Device>(DEVICE_COOKIE))!.client_id);
    const second = await jar.callback(cb);
    expect(second.status).toBe(502);
    expect(second.headers.get("content-type")).toContain("text/html");
    expect(await second.text()).toContain('href="/auth/login"');
    expect(jar.values.has(LOGIN_COOKIE)).toBe(false);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
    expect(server.registrations).toHaveLength(2);
  });

  it("renders an error parameter as an escaped page with a link to sign in again", async () => {
    const jar = new Jar();
    await jar.login();
    const { state } = (await jar.unseal<Login>(LOGIN_COOKIE))!;
    const out = await jar.callback(
      `/auth/callback?error=access_denied&state=${state}&error_description=${encodeURIComponent('<script>alert(1)</script>"&')}`,
    );
    expect(out.status).toBe(400);
    expect(out.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await out.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;");
    expect(html).toContain("access_denied");
    expect(html).toContain('<a href="/auth/login">Sign in again</a>');
    expect(jar.values.has(LOGIN_COOKIE)).toBe(false);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
  });

  it("keeps the login cookie when an error arrives without this sign-in's state", async () => {
    const jar = new Jar();
    await jar.login();
    const out = await jar.callback("/auth/callback?error=access_denied&state=forged");
    expect(out.status).toBe(400);
    expect(jar.values.has(LOGIN_COOKIE)).toBe(true);
  });

  it("shows a 502 page and clears only the login cookie when /token fails", async () => {
    const jar = new Jar();
    const res = await jar.login();
    const cb = await server.authorize(res.headers.get("location")!);
    server.tokenFailure = 500;
    const out = await jar.callback(cb);
    expect(out.status).toBe(502);
    expect(out.headers.getSetCookie()).toEqual([expect.stringMatching(new RegExp(`^${LOGIN_COOKIE}=;.*Max-Age=0`))]);
    expect(jar.values.has(DEVICE_COOKIE)).toBe(true);
  });

  it("shows the error page for a refused code (invalid_grant)", async () => {
    const jar = new Jar();
    const res = await jar.login();
    const cb = new URL(await server.authorize(res.headers.get("location")!));
    cb.searchParams.set("code", "code-unknown");
    const out = await jar.callback(cb.toString());
    expect(out.status).toBe(400);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
    expect(jar.values.has(DEVICE_COOKIE)).toBe(true);
  });
});

describe("POST /auth/logout", () => {
  const cases: [string, Record<string, string>][] = [
    ["no X-Potem header", { origin: WEB }],
    ["a foreign Origin", { "x-potem": "1", origin: "https://evil.example" }],
    ["no Origin", { "x-potem": "1" }],
    ["X-Potem other than 1", { "x-potem": "yes", origin: WEB }],
  ];
  for (const [name, headers] of cases) {
    it(`refuses ${name} with 403 and keeps the session`, async () => {
      const jar = new Jar();
      await jar.signIn();
      const tokenCalls = server.tokenRequests.length;
      const res = await jar.logout(headers);
      expect(res.status).toBe(403);
      expect(jar.values.has(SESSION_COOKIE)).toBe(true);
      expect(server.tokenRequests).toHaveLength(tokenCalls);
      expect(server.liveGrants()).toHaveLength(1);
    });
  }

  it("revokes the grant with the refresh token, clears the session and keeps the device", async () => {
    const jar = new Jar();
    await jar.signIn();
    const s = (await jar.unseal<Session>(SESSION_COOKIE))!;
    const device = (await jar.unseal<Device>(DEVICE_COOKIE))!;
    const res = await jar.logout();
    expect(res.status).toBe(204);
    const req = server.tokenRequests.at(-1)!;
    expect(req.form.get("token")).toBe(s.refresh_token);
    expect(req.form.get("token_type_hint")).toBe("refresh_token");
    expect(req.form.has("grant_type")).toBe(false);
    expect(req.headers.get("authorization")).toBe(`Basic ${btoa(`${device.client_id}:${device.client_secret}`)}`);
    expect(server.liveGrants()).toHaveLength(0);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
    expect(jar.values.has(DEVICE_COOKIE)).toBe(true);
  });

  it("clears the session even when revocation answers 500", async () => {
    const jar = new Jar();
    await jar.signIn();
    server.tokenFailure = 500;
    const res = await jar.logout();
    expect(res.status).toBe(204);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
  });

  it("clears the session even when the server can't be reached", async () => {
    const jar = new Jar();
    await jar.signIn();
    cfg.upstream = async () => {
      throw new TypeError("fetch failed");
    };
    const res = await jar.logout();
    expect(res.status).toBe(204);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
  });

  it("answers 204 and clears the cookie when the session is missing or unreadable", async () => {
    const jar = new Jar();
    jar.values.set(SESSION_COOKIE, "garbage");
    const res = await jar.logout();
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`))]);
    expect(server.tokenRequests).toHaveLength(0);
  });
});

describe("upstream helpers", () => {
  it("sends SERVER_ORIGIN + path without following redirects, and refuses other paths", async () => {
    const seen: Request[] = [];
    const up = upstreamVia(SERVER, async (r) => (seen.push(r), new Response(null, { status: 204 })));
    await up("/api/v1/sync/info");
    expect(seen[0].url).toBe(`${SERVER}/api/v1/sync/info`);
    expect(seen[0].redirect).toBe("manual");
    expect(() => up("//evil.example/x")).toThrow();
    expect(() => up("api/v1")).toThrow();
  });

  it("form-encodes Basic credentials the way the server decodes them", async () => {
    const dec = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
    const header = basicAuth({ client_id: "id:with space", client_secret: "s+e/c%r=t" });
    const raw = atob(header.replace(/^Basic /, ""));
    const sep = raw.indexOf(":");
    expect(dec(raw.slice(0, sep))).toBe("id:with space");
    expect(dec(raw.slice(sep + 1))).toBe("s+e/c%r=t");
  });
});
