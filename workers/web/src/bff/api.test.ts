import { beforeEach, describe, expect, it } from "vitest";
import { apiPath, handleApi, handleRefresh, handleSession } from "./api.ts";
import { handleCallback, handleLogin } from "./auth.ts";
import { DEVICE_COOKIE, SESSION_COOKIE } from "./cookies.ts";
import { sealer } from "./seal.ts";
import type { Session } from "./session.ts";
import { CF_ACCESS_EXPIRES_AT, CF_ACCESS_TOKEN, TestServer } from "./test-server.ts";
import { type BffConfig, upstreamVia } from "./upstream.ts";

const WEB = "https://web.example.com";
const SERVER = "https://server.example.com";
const SECRET = "test-secret-test-secret-test-secret-0123";
const START = 1_800_000_000;

let server: TestServer;
let cfg: BffConfig;
let now: number;
let sleeps: number[];

beforeEach(() => {
  server = new TestServer(SERVER);
  now = START;
  sleeps = [];
  cfg = {
    webOrigin: WEB,
    serverOrigin: SERVER,
    secret: SECRET,
    maxHours: 12,
    idleMinutes: 60,
    upstream: upstreamVia(SERVER, (r) => server.fetch(r)),
    now: () => now,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
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
  request(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    if (this.values.size) headers.set("cookie", [...this.values].map(([k, v]) => `${k}=${v}`).join("; "));
    return new Request(new URL(path, WEB), { ...init, headers });
  }
  async signIn(): Promise<void> {
    const login = this.store(await handleLogin(this.request("/auth/login"), cfg));
    const back = await server.authorize(login.headers.get("location")!);
    const res = this.store(await handleCallback(this.request(back), cfg));
    expect(res.status).toBe(302);
  }
  async session(): Promise<Response> {
    return this.store(await handleSession(this.request("/bff/session"), cfg));
  }
  async refresh(headers: Record<string, string> = { "x-potem": "1", origin: WEB }): Promise<Response> {
    return this.store(await handleRefresh(this.request("/bff/session/refresh", { method: "POST", headers }), cfg));
  }
  async api(path: string, init: RequestInit = {}): Promise<Response> {
    return this.store(await handleApi(this.request(`/bff/api/${path}`, init), cfg));
  }
  async unseal<T>(name: string): Promise<T | null> {
    const v = this.values.get(name);
    return v ? (await sealer(SECRET)).unseal<T>(name, v) : null;
  }
}

const sessionCookies = (res: Response) => res.headers.getSetCookie().filter((l) => l.startsWith(`${SESSION_COOKIE}=`));
const isClear = (line: string) => line.includes("Max-Age=0");

async function signedIn(): Promise<Jar> {
  const jar = new Jar();
  await jar.signIn();
  return jar;
}

describe("GET /bff/session", () => {
  it("answers signed_in false without a session", async () => {
    const res = await new Jar().session();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ signed_in: false });
  });

  it("answers signed_in, the absolute end of the session and the data key", async () => {
    const jar = await signedIn();
    const session = (await jar.unseal<Session>(SESSION_COOKIE))!;
    const res = await jar.session();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      signed_in: true,
      expires_at: START + 12 * 3600,
      idle_minutes: 60,
      refresh_at: session.access_exp - 60,
      now: START,
      data_key: session.data_key,
    });
  });

  it("moves refresh_at with the access token after a refresh", async () => {
    const jar = await signedIn();
    now += 3600 - 30;
    expect((await jar.refresh()).status).toBe(204);
    const session = (await jar.unseal<Session>(SESSION_COOKIE))!;
    const body = (await (await jar.session()).json()) as { refresh_at: number; now: number };
    expect(body.refresh_at).toBe(session.access_exp - 60);
    expect(body.refresh_at).toBe(now + 3600 - 60);
    expect(body.now).toBe(now);
  });

  it("ends expires_at at cf_access_exp when the Access token runs out first", async () => {
    server.access = "forbidden";
    const jar = await signedIn();
    expect(CF_ACCESS_EXPIRES_AT).toBeGreaterThan(START);
    cfg.maxHours = (CF_ACCESS_EXPIRES_AT - START) / 3600 + 1;
    const body = (await (await jar.session()).json()) as { expires_at: number };
    expect(body.expires_at).toBe(CF_ACCESS_EXPIRES_AT);
  });

  it("touches last_seen at most once a minute", async () => {
    const jar = await signedIn();
    now += 30;
    expect(sessionCookies(await jar.session())).toHaveLength(0);
    now += 30;
    const res = await jar.session();
    const lines = sessionCookies(res);
    expect(lines).toHaveLength(1);
    // The cookie lives until the session's absolute end, not maxHours from now.
    expect(lines[0]).toContain(`Max-Age=${12 * 3600 - 60}`);
    const session = (await jar.unseal<Session>(SESSION_COOKIE))!;
    expect(session.last_seen).toBe(START + 60);
    expect(session.created_at).toBe(START);
  });

  it("still answers signed_in when the access token is due for refresh", async () => {
    const jar = await signedIn();
    now += 3600 - 30;
    jar.values.set(SESSION_COOKIE, await reseal(jar, { last_seen: now }));
    expect(((await (await jar.session()).json()) as { signed_in: boolean }).signed_in).toBe(true);
  });

  it("signs out after the idle limit and clears the cookie", async () => {
    const jar = await signedIn();
    now += 60 * 60;
    const res = await jar.session();
    expect(await res.json()).toEqual({ signed_in: false });
    expect(sessionCookies(res).every(isClear)).toBe(true);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
  });

  it("signs out at the absolute limit even when the session stayed active", async () => {
    const jar = await signedIn();
    for (let i = 0; i < 14; i++) {
      now += 50 * 60;
      expect(((await (await jar.session()).json()) as { signed_in: boolean }).signed_in).toBe(true);
    }
    now = START + 12 * 3600;
    expect(await (await jar.session()).json()).toEqual({ signed_in: false });
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
  });

  it("treats an unreadable cookie as signed out and clears it", async () => {
    const jar = new Jar();
    jar.values.set(SESSION_COOKIE, "garbage");
    const res = await jar.session();
    expect(await res.json()).toEqual({ signed_in: false });
    expect(sessionCookies(res).every(isClear)).toBe(true);
  });
});

/** The jar's session with some fields replaced, sealed again. */
async function reseal(jar: Jar, fields: Partial<Session>): Promise<string> {
  const session = (await jar.unseal<Session>(SESSION_COOKIE))!;
  return (await sealer(SECRET)).seal(SESSION_COOKIE, { ...session, ...fields });
}

/** Signed in, with the access token inside the refresh window. */
async function dueSignedIn(): Promise<Jar> {
  const jar = await signedIn();
  now += 3600 - 30;
  return jar;
}

describe("POST /bff/session/refresh", () => {
  it("is a no-op on a session that isn't due: no token call, no cookie", async () => {
    const jar = await signedIn();
    const before = server.tokenRequests.length;
    now += 60;
    const res = await jar.refresh();
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(server.tokenRequests.length).toBe(before);
  });

  it("rotates a session that isn't due when X-Potem-Force is sent", async () => {
    const jar = await signedIn();
    const old = (await jar.unseal<Session>(SESSION_COOKIE))!;
    const before = server.tokenRequests.length;
    now += 60;
    const res = await jar.refresh({ "x-potem": "1", "x-potem-force": "1", origin: WEB });
    expect(res.status).toBe(204);
    expect(sessionCookies(res)).toHaveLength(1);
    expect(server.tokenRequests.length - before).toBe(1);
    const fresh = (await jar.unseal<Session>(SESSION_COOKIE))!;
    expect(fresh.access_token).not.toBe(old.access_token);
    expect(fresh.refresh_token).not.toBe(old.refresh_token);
  });

  it("still signs out an expired session when X-Potem-Force is sent", async () => {
    const jar = await signedIn();
    const before = server.tokenRequests.length;
    now += 13 * 3600;
    const res = await jar.refresh({ "x-potem": "1", "x-potem-force": "1", origin: WEB });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(server.tokenRequests.length).toBe(before);
  });

  it("still refuses a forced refresh without X-Potem and the web Origin", async () => {
    const jar = await signedIn();
    const before = server.tokenRequests.length;
    expect((await jar.refresh({ "x-potem-force": "1", origin: WEB })).status).toBe(403);
    expect((await jar.refresh({ "x-potem": "1", "x-potem-force": "1", origin: "https://evil.example.com" })).status).toBe(403);
    expect(server.tokenRequests.length).toBe(before);
  });

  it("refuses a request without X-Potem and the web Origin", async () => {
    const jar = await signedIn();
    const before = server.tokenRequests.length;
    expect((await jar.refresh({ origin: WEB })).status).toBe(403);
    expect((await jar.refresh({ "x-potem": "1", origin: "https://evil.example.com" })).status).toBe(403);
    expect(server.tokenRequests.length).toBe(before);
  });

  it("refreshes with Basic auth, rewrites the cookie once and keeps created_at and data_key", async () => {
    const jar = await signedIn();
    const old = (await jar.unseal<Session>(SESSION_COOKIE))!;
    now += 3600 - 30;
    const res = await jar.refresh();
    expect(res.status).toBe(204);
    expect(sessionCookies(res)).toHaveLength(1);
    expect(res.headers.getSetCookie().filter((l) => l.startsWith(`${DEVICE_COOKIE}=`))).toHaveLength(0);

    const req = server.tokenRequests.at(-1)!;
    expect(req.headers.get("authorization")).toMatch(/^Basic /);
    expect(Object.fromEntries(req.form)).toEqual({ grant_type: "refresh_token", refresh_token: old.refresh_token });

    const fresh = (await jar.unseal<Session>(SESSION_COOKIE))!;
    expect(fresh.access_token).not.toBe(old.access_token);
    expect(fresh.refresh_token).toBe(server.grants[0].refresh_token);
    expect(fresh.refresh_token).not.toBe(old.refresh_token);
    expect(fresh.access_exp).toBe(now + 3600);
    expect(fresh.created_at).toBe(START);
    expect(fresh.last_seen).toBe(now);
    expect(fresh.data_key).toBe(old.data_key);

    // The new access token works upstream.
    expect((await jar.api("sync/info")).status).toBe(200);
  });

  it("keeps cf_access_token and cf_access_exp, which the refresh response doesn't carry", async () => {
    server.access = "forbidden";
    const jar = await dueSignedIn();
    expect((await jar.refresh()).status).toBe(204);
    const fresh = (await jar.unseal<Session>(SESSION_COOKIE))!;
    expect(fresh.cf_access_token).toBe(CF_ACCESS_TOKEN);
    expect(fresh.cf_access_exp).toBe(CF_ACCESS_EXPIRES_AT);
  });

  it("keeps the old refresh token when the response doesn't rotate it", async () => {
    const jar = await dueSignedIn();
    const old = (await jar.unseal<Session>(SESSION_COOKIE))!;
    const plain = cfg.upstream;
    cfg.upstream = async (path, init) => {
      const res = await plain(path, init);
      if (path !== "/token" || res.status !== 200) return res;
      const { refresh_token: _, ...body } = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    expect((await jar.refresh()).status).toBe(204);
    expect((await jar.unseal<Session>(SESSION_COOKIE))!.refresh_token).toBe(old.refresh_token);
  });

  it("retries once after 1 s on invalid_grant and succeeds when the retry does", async () => {
    const jar = await dueSignedIn();
    const before = server.tokenRequests.length;
    server.refreshRefusals = 1;
    const res = await jar.refresh();
    expect(res.status).toBe(204);
    expect(sleeps).toEqual([1000]);
    expect(server.tokenRequests.length - before).toBe(2);
    expect(sessionCookies(res)).toHaveLength(1);
  });

  it("signs out after invalid_grant twice: clears the cookie and answers signed_out", async () => {
    const jar = await dueSignedIn();
    const before = server.tokenRequests.length;
    server.refreshRefusals = 2;
    const res = await jar.refresh();
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(sleeps).toEqual([1000]);
    expect(server.tokenRequests.length - before).toBe(2);
    expect(sessionCookies(res).every(isClear)).toBe(true);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
    expect(jar.values.has(DEVICE_COOKIE)).toBe(true);
  });

  it("signs out without calling the server when the session has expired", async () => {
    const jar = await dueSignedIn();
    const before = server.tokenRequests.length;
    now += 60 * 60;
    const res = await jar.refresh();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(server.tokenRequests.length).toBe(before);
    expect(jar.values.has(SESSION_COOKIE)).toBe(false);
  });

  it("signs out without calling the server when there is no device", async () => {
    const jar = await dueSignedIn();
    jar.values.delete(DEVICE_COOKIE);
    const before = server.tokenRequests.length;
    const res = await jar.refresh();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(server.tokenRequests.length).toBe(before);
  });

  it("signs out without a retry when the client registration is gone", async () => {
    const jar = await dueSignedIn();
    server.deleteClient(server.grants[0].client_id);
    const before = server.tokenRequests.length;
    const res = await jar.refresh();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(server.tokenRequests.length - before).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("answers 502 upstream_unavailable and leaves the cookie alone when the server fails", async () => {
    const jar = await dueSignedIn();
    server.tokenFailure = 503;
    const res = await jar.refresh();
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "upstream_unavailable" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("answers 502 upstream_unavailable when the server can't be reached", async () => {
    const jar = await dueSignedIn();
    cfg.upstream = async () => {
      throw new TypeError("network down");
    };
    const res = await jar.refresh();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unavailable" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("GET /bff/api/*", () => {
  const allowed = [
    "sync/info",
    "sync/changes",
    "search",
    "tasks/T_abc-123",
    "attachments/A_9",
    "theme-images/0123456789abcdef0123456789abcdef",
    "link-rules",
    "lists/excluded",
  ];

  for (const path of allowed) {
    it(`proxies ${path} with its query, the bearer token and nothing else of the browser's`, async () => {
      const jar = await signedIn();
      const session = (await jar.unseal<Session>(SESSION_COOKIE))!;
      const res = await jar.api(`${path}?cursor=a%2Bb&limit=5&q=x y`, {
        headers: { "x-custom": "1", authorization: "Bearer forged" },
      });
      expect(res.status).toBe(200);
      const req = server.apiRequests.at(-1)!;
      expect(req.path).toBe(`/api/v1/${path}?cursor=a%2Bb&limit=5&q=x%20y`);
      expect(req.headers.get("authorization")).toBe(`Bearer ${session.access_token}`);
      expect(req.headers.has("cf-access-token")).toBe(false);
      expect(req.headers.has("cookie")).toBe(false);
      expect(req.headers.has("x-custom")).toBe(false);
    });
  }

  it("sends cf-access-token when the session carries one", async () => {
    server.access = "forbidden";
    const jar = await signedIn();
    await jar.api("sync/info");
    expect(server.apiRequests.at(-1)!.headers.get("cf-access-token")).toBe(CF_ACCESS_TOKEN);
  });

  it("passes status, body and the listed headers through, never Set-Cookie", async () => {
    const jar = await signedIn();
    server.apiReply = () =>
      new Response("file bytes", {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="a.pdf"',
          "content-length": "10",
          etag: '"v7"',
          "last-modified": "Wed, 01 Jan 2031 00:00:00 GMT",
          "set-cookie": "upstream=1; Path=/",
          "x-internal": "secret",
        },
      });
    const res = await jar.api("attachments/A_1");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("file bytes");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="a.pdf"');
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("etag")).toBe('"v7"');
    expect(res.headers.get("last-modified")).toBe("Wed, 01 Jan 2031 00:00:00 GMT");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.has("x-internal")).toBe(false);
  });

  it("drops content-length when the upstream response has a content-encoding", async () => {
    const jar = await signedIn();
    server.apiReply = () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "20", "content-encoding": "gzip" },
      });
    const res = await jar.api("sync/info");
    expect(res.status).toBe(200);
    expect(res.headers.has("content-length")).toBe(false);
    expect(res.headers.has("content-encoding")).toBe(false);
  });

  it("turns an upstream 403 access_denied into signed_out and clears the cookie", async () => {
    const jar = await signedIn();
    server.apiReply = () => new Response(JSON.stringify({ error: "access_denied" }), { status: 403, headers: { "content-type": "application/json" } });
    const res = await jar.api("sync/changes");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(sessionCookies(res).map(isClear)).toEqual([true]);
  });

  it("passes another 403 through unchanged", async () => {
    const jar = await signedIn();
    server.apiReply = () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
    const res = await jar.api("sync/changes");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(sessionCookies(res)).toEqual([]);
  });

  it("passes a contract error through unchanged", async () => {
    const jar = await signedIn();
    server.apiReply = () => new Response(JSON.stringify({ error: "cursor_reset" }), { status: 410, headers: { "content-type": "application/json" } });
    const res = await jar.api("sync/changes?cursor=old");
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "cursor_reset" });
  });

  it("never writes the session cookie, even after a minute", async () => {
    const jar = await signedIn();
    now += 5 * 60;
    const res = await jar.api("sync/changes");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("refuses a path outside the allowlist with 404 and doesn't call the server", async () => {
    const jar = await signedIn();
    for (const path of ["sync/mutations", "tasks", "tasks/a/b", "sync/info/", "token", "attachments/a.b"]) {
      expect((await jar.api(path)).status, path).toBe(404);
    }
    expect(server.apiRequests).toHaveLength(0);
  });

  it("refuses a method other than GET with 405", async () => {
    const jar = await signedIn();
    const res = await jar.api("sync/changes", { method: "POST", body: "{}" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(server.apiRequests).toHaveLength(0);
  });

  it("ten parallel calls with an expiring session make no token call and all ask for a refresh", async () => {
    const jar = await signedIn();
    const tokenCalls = server.tokenRequests.length;
    now += 3600 - 30;
    jar.values.set(SESSION_COOKIE, await reseal(jar, { last_seen: now }));
    const responses = await Promise.all(Array.from({ length: 10 }, () => jar.api("sync/changes")));
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual({ error: "session_refresh_needed" });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(server.tokenRequests.length - tokenCalls).toBe(0);
    expect(server.apiRequests).toHaveLength(0);
  });

  it("answers signed_out and clears the cookie for an idle session", async () => {
    const jar = await signedIn();
    now += 60 * 60;
    const res = await jar.api("sync/info");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(sessionCookies(res).every(isClear)).toBe(true);
    expect(server.apiRequests).toHaveLength(0);
  });

  it("answers signed_out at the absolute limit", async () => {
    const jar = await signedIn();
    now = START + 12 * 3600;
    jar.values.set(SESSION_COOKIE, await reseal(jar, { last_seen: now - 60, access_exp: now + 3600 }));
    const res = await jar.api("sync/info");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
  });

  it("answers signed_out without a session, and sets no cookie when none was sent", async () => {
    const res = await new Jar().api("sync/info");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("clears an unreadable session cookie", async () => {
    const jar = new Jar();
    jar.values.set(SESSION_COOKIE, "garbage");
    const res = await jar.api("sync/info");
    expect(res.status).toBe(401);
    expect(sessionCookies(res)).toHaveLength(1);
    expect(sessionCookies(res).every(isClear)).toBe(true);
  });

  const served = (contentType: string, disposition?: string) => () =>
    new Response("bytes", {
      headers: { "content-type": contentType, ...(disposition ? { "content-disposition": disposition } : {}) },
    });

  for (const type of ["text/html", "text/javascript; charset=utf-8", "image/svg+xml", "application/xml", "text/plain"]) {
    it(`serves an attachment sent as ${type} as a download of application/octet-stream`, async () => {
      const jar = await signedIn();
      server.apiReply = served(type, "inline");
      const res = await jar.api("attachments/A_1");
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toBe("attachment");
    });
  }

  for (const type of ["IMAGE/PNG", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf; name=x"]) {
    it(`keeps an attachment's ${type}, still as a download`, async () => {
      const jar = await signedIn();
      server.apiReply = served(type);
      const res = await jar.api("attachments/A_1");
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.headers.get("content-disposition")).toBe("attachment");
    });
  }

  it("keeps the upstream filename on an attachment but forces attachment", async () => {
    const jar = await signedIn();
    server.apiReply = served("text/html", "inline; filename=\"x.html\"; filename*=UTF-8''x.html");
    const res = await jar.api("attachments/A_1");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=\"x.html\"; filename*=UTF-8''x.html");
  });

  it("keeps a JSON error from the attachment route readable, and nothing else", async () => {
    const jar = await signedIn();
    server.apiReply = () => new Response('{"error":"not_found"}', { status: 404, headers: { "content-type": "application/json" } });
    let res = await jar.api("attachments/A_1");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    server.apiReply = () => new Response("<script>", { status: 404, headers: { "content-type": "text/html" } });
    res = await jar.api("theme-images/abc");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("serves a theme image only as a raster image type", async () => {
    const jar = await signedIn();
    server.apiReply = served("text/html");
    expect((await jar.api("theme-images/abc")).headers.get("content-type")).toBe("application/octet-stream");
    server.apiReply = served("image/svg+xml");
    expect((await jar.api("theme-images/abc")).headers.get("content-type")).toBe("application/octet-stream");
    server.apiReply = served("application/pdf");
    expect((await jar.api("theme-images/abc")).headers.get("content-type")).toBe("application/octet-stream");
    server.apiReply = served("image/webp");
    expect((await jar.api("theme-images/abc")).headers.get("content-type")).toBe("image/webp");
  });

  it("turns an upstream 401 into session_refresh_needed", async () => {
    const jar = await signedIn();
    server.grants[0].revoked = true;
    const res = await jar.api("sync/info");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "session_refresh_needed" });
    expect(res.headers.has("www-authenticate")).toBe(false);
  });

  it("turns an upstream redirect into 502 upstream_redirect without a Location", async () => {
    const jar = await signedIn();
    server.apiReply = () =>
      new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
    const res = await jar.api("sync/info");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_redirect" });
    expect(res.headers.has("location")).toBe(false);
  });

  it("answers 502 upstream_unavailable when the server can't be reached", async () => {
    const jar = await signedIn();
    cfg.upstream = async () => {
      throw new TypeError("network down");
    };
    const res = await jar.api("sync/info");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unavailable" });
  });
});

describe("apiPath", () => {
  it("maps an allowlisted path to /api/v1", () => {
    expect(apiPath("tasks/abc_D-9")).toBe("/api/v1/tasks/abc_D-9");
    expect(apiPath("sync/info")).toBe("/api/v1/sync/info");
  });

  it("refuses encoded, dotted, doubled, backslashed and empty segments", () => {
    for (const raw of [
      "../token",
      "tasks/..",
      "%2e%2e/token",
      "tasks/%41",
      "sync//info",
      "/sync/info",
      "sync/info/",
      "tasks\\abc",
      "",
      "tasks/" + "a".repeat(129),
    ]) {
      expect(apiPath(raw), raw).toBeNull();
    }
    expect(apiPath("tasks/" + "a".repeat(128))).toBe("/api/v1/tasks/" + "a".repeat(128));
  });
});
