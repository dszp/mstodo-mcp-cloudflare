import { beforeEach, describe, expect, it } from "vitest";
import { apiRoute, handleApi, handleRefresh, handleSession } from "./api.ts";
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
  /** GET /bff/session; `activity` adds X-Potem-Activity: 1, as the page does after user activity. */
  async session(activity = false): Promise<Response> {
    const headers: Record<string, string> = activity ? { "x-potem-activity": "1" } : {};
    return this.store(await handleSession(this.request("/bff/session", { headers }), cfg));
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
      refresh_at: session.access_exp - 59,
      now: START,
      data_key: session.data_key,
    });
  });

  it("names the first second at which a refresh rotates, not the no-op one before it", async () => {
    const jar = await signedIn();
    const { refresh_at } = (await (await jar.session()).json()) as { refresh_at: number };
    const before = (await jar.unseal<Session>(SESSION_COOKIE))!.refresh_token;
    now = refresh_at - 1;
    await jar.refresh();
    expect((await jar.unseal<Session>(SESSION_COOKIE))!.refresh_token).toBe(before);
    now = refresh_at;
    await jar.refresh();
    expect((await jar.unseal<Session>(SESSION_COOKIE))!.refresh_token).not.toBe(before);
  });

  it("moves refresh_at with the access token after a refresh", async () => {
    const jar = await signedIn();
    now += 3600 - 30;
    expect((await jar.refresh()).status).toBe(204);
    const session = (await jar.unseal<Session>(SESSION_COOKIE))!;
    const body = (await (await jar.session()).json()) as { refresh_at: number; now: number };
    expect(body.refresh_at).toBe(session.access_exp - 59);
    expect(body.refresh_at).toBe(now + 3600 - 59);
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

  it("doesn't touch last_seen without X-Potem-Activity", async () => {
    const jar = await signedIn();
    now += 30 * 60;
    expect(sessionCookies(await jar.session())).toHaveLength(0);
    expect((await jar.unseal<Session>(SESSION_COOKIE))!.last_seen).toBe(START);
  });

  it("with X-Potem-Activity, touches last_seen at most once a minute", async () => {
    const jar = await signedIn();
    now += 30;
    expect(sessionCookies(await jar.session(true))).toHaveLength(0);
    now += 30;
    const res = await jar.session(true);
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
      expect(((await (await jar.session(true)).json()) as { signed_in: boolean }).signed_in).toBe(true);
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
    // A refresh is automatic: only reported activity moves the idle timer.
    expect(fresh.last_seen).toBe(old.last_seen);
    expect(fresh.data_key).toBe(old.data_key);

    // The new access token works upstream.
    expect((await jar.api("sync/info")).status).toBe(200);
  });

  it("a session refreshed again and again without reported activity still ends at last_seen + idle", async () => {
    cfg.idleMinutes = 150; // longer than two access tokens (3600 s each)
    const jar = await signedIn();
    for (const at of [3600 - 30, 2 * 3600 - 60]) {
      now = START + at;
      expect((await jar.refresh()).status).toBe(204);
      expect((await jar.unseal<Session>(SESSION_COOKIE))!.last_seen).toBe(START);
    }
    now = START + 150 * 60;
    const res = await jar.refresh();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(sessionCookies(res).every(isClear)).toBe(true);
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
    for (const path of ["sync/mutation", "sync/mutations/x", "tasks", "tasks/a/b", "sync/info/", "token", "attachments/a.b"]) {
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

const MAX_BODY = 256 * 1024;
const POST_HEADERS = { "x-potem": "1", origin: WEB, "content-type": "application/json" };
const BATCH = {
  client_id: "web-0190",
  mutations: [{ id: "m-1", at: "2031-01-01T10:00:00.000Z", op: "task.update", sid: "T_1", fields: { title: "Call example" } }],
};

/** A JSON batch of exactly `size` bytes. */
function batchOfSize(size: number): Uint8Array<ArrayBuffer> {
  const head = '{"client_id":"web-0190","mutations":[],"pad":"';
  const text = head + "a".repeat(size - head.length - 2) + '"}';
  const bytes = new Uint8Array(new TextEncoder().encode(text));
  expect(bytes.byteLength).toBe(size);
  return bytes;
}

/** A stream of `chunks` chunks of `chunkSize` bytes that records how many were pulled. */
function chunkedBody(chunks: number, chunkSize: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === chunks) return controller.close();
      state.pulled++;
      controller.enqueue(new Uint8Array(chunkSize).fill(0x20));
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 }); // pulled only when read, so `pulled` counts reads
  return { stream, state };
}

describe("POST /bff/api/sync/mutations", () => {
  const post = (jar: Jar, body: BodyInit | null, headers: Record<string, string> = POST_HEADERS, extra: RequestInit = {}) =>
    jar.api("sync/mutations", { method: "POST", headers, body, ...extra });
  const mutationCalls = () => server.apiRequests.filter((r) => r.path === "/api/v1/sync/mutations");

  it("forwards the exact bytes with the bearer token and JSON type, and nothing else of the browser's", async () => {
    const jar = await signedIn();
    const session = (await jar.unseal<Session>(SESSION_COOKIE))!;
    // Odd spacing and non-ASCII text: the bytes go through untouched, not re-serialized.
    const text = `{ "client_id":"web-0190",\n "mutations":[{"id":"m-1","at":"2031-01-01T10:00:00.000Z","op":"task.update","sid":"T_1","fields":{"title":"Café ✓"}}] }`;
    const bytes = new TextEncoder().encode(text);
    const res = await post(jar, bytes, {
      ...POST_HEADERS,
      "content-type": "Application/JSON; charset=UTF-8",
      "x-custom": "1",
      authorization: "Bearer forged",
    });
    expect(res.status).toBe(200);
    const [call] = mutationCalls();
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v1/sync/mutations");
    expect(call.body).toEqual(bytes);
    expect(call.headers.get("authorization")).toBe(`Bearer ${session.access_token}`);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.has("cf-access-token")).toBe(false);
    expect(call.headers.has("cookie")).toBe(false);
    expect(call.headers.has("x-potem")).toBe(false);
    expect(call.headers.has("origin")).toBe(false);
    expect(call.headers.has("x-custom")).toBe(false);
  });

  it("returns the server's status and JSON body, with only its Content-Type", async () => {
    const jar = await signedIn();
    const res = await post(jar, JSON.stringify(BATCH));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ cursor: "cursor-1", results: [{ id: "m-1", status: "applied", sid: "T_1" }] });

    server.apiReply = () =>
      new Response('{"error":"bad_batch","detail":"mutations"}', {
        status: 400,
        headers: { "content-type": "application/json", "set-cookie": "upstream=1; Path=/", etag: '"e"', "x-internal": "secret" },
      });
    const bad = await post(jar, JSON.stringify(BATCH));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "bad_batch", detail: "mutations" });
    expect([...bad.headers.keys()]).toEqual(["content-type"]);
  });

  it("never passes on a non-JSON Content-Type from the server", async () => {
    const jar = await signedIn();
    server.apiReply = () => new Response("<script>", { status: 500, headers: { "content-type": "text/html" } });
    const res = await post(jar, JSON.stringify(BATCH));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("sends cf-access-token when the session carries one", async () => {
    server.access = "forbidden";
    const jar = await signedIn();
    await post(jar, JSON.stringify(BATCH));
    expect(mutationCalls()[0].headers.get("cf-access-token")).toBe(CF_ACCESS_TOKEN);
  });

  it("refuses a request without X-Potem and the web Origin with 403 forbidden", async () => {
    const jar = await signedIn();
    const cases: Record<string, string>[] = [
      { origin: WEB, "content-type": "application/json" },
      { "x-potem": "0", origin: WEB, "content-type": "application/json" },
      { "x-potem": "1", "content-type": "application/json" },
      { "x-potem": "1", origin: "https://evil.example.com", "content-type": "application/json" },
      { "x-potem": "1", origin: "null", "content-type": "application/json" },
    ];
    for (const headers of cases) {
      const res = await post(jar, JSON.stringify(BATCH), headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    expect(server.apiRequests).toHaveLength(0);
  });

  it("refuses any Content-Type but application/json with 415", async () => {
    const jar = await signedIn();
    for (const type of [null, "text/plain", "application/jsonx", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/json"]) {
      const headers: Record<string, string> = { "x-potem": "1", origin: WEB };
      if (type) headers["content-type"] = type;
      // A string body would get text/plain from the runtime, so send bytes.
      const res = await post(jar, new TextEncoder().encode(JSON.stringify(BATCH)), headers);
      expect(res.status, String(type)).toBe(415);
      expect(await res.json()).toEqual({ error: "unsupported_media_type" });
    }
    expect(server.apiRequests).toHaveLength(0);
  });

  it("forwards a body of exactly 256 KiB", async () => {
    const jar = await signedIn();
    const bytes = batchOfSize(MAX_BODY);
    const res = await post(jar, bytes);
    expect(res.status).toBe(200);
    expect(mutationCalls()[0].body).toEqual(bytes);
  });

  it("refuses a body of 256 KiB and one byte with 413", async () => {
    const jar = await signedIn();
    const res = await post(jar, batchOfSize(MAX_BODY + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body_too_large", max: MAX_BODY });
    expect(server.apiRequests).toHaveLength(0);
  });

  it("refuses a Content-Length over the limit before reading the body", async () => {
    const jar = await signedIn();
    const { stream, state } = chunkedBody(1, 16);
    const res = await post(jar, stream, { ...POST_HEADERS, "content-length": String(MAX_BODY + 1) }, { duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(state.pulled).toBe(0);
    expect(server.apiRequests).toHaveLength(0);
  });

  it("refuses a chunked body without Content-Length once it passes the limit, and stops reading", async () => {
    const jar = await signedIn();
    // 80 chunks of 4 KiB: 320 KiB, so the limit is crossed at the 65th.
    const { stream, state } = chunkedBody(80, 4096);
    const res = await post(jar, stream, POST_HEADERS, { duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(state.pulled).toBeLessThan(80);
    expect(state.cancelled).toBe(true);
    expect(server.apiRequests).toHaveLength(0);
  });

  it("refuses a body longer than its Content-Length claims", async () => {
    const jar = await signedIn();
    const { stream } = chunkedBody(80, 4096);
    const res = await post(jar, stream, { ...POST_HEADERS, "content-length": "10" }, { duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(server.apiRequests).toHaveLength(0);
  });

  it("asks for a refresh with an expiring session, without calling the server", async () => {
    const jar = await signedIn();
    const tokenCalls = server.tokenRequests.length;
    now += 3600 - 30;
    jar.values.set(SESSION_COOKIE, await reseal(jar, { last_seen: now }));
    const res = await post(jar, JSON.stringify(BATCH));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "session_refresh_needed" });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(server.apiRequests).toHaveLength(0);
    expect(server.tokenRequests.length).toBe(tokenCalls);
  });

  it("answers signed_out and clears the cookie for an expired session", async () => {
    const jar = await signedIn();
    now += 60 * 60;
    const res = await post(jar, JSON.stringify(BATCH));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(sessionCookies(res).map(isClear)).toEqual([true]);
    expect(server.apiRequests).toHaveLength(0);
  });

  it("answers signed_out without a session", async () => {
    const res = await post(new Jar(), JSON.stringify(BATCH));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("turns an upstream 401 into session_refresh_needed", async () => {
    const jar = await signedIn();
    server.grants[0].revoked = true;
    const res = await post(jar, JSON.stringify(BATCH));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "session_refresh_needed" });
    expect(res.headers.has("www-authenticate")).toBe(false);
  });

  it("turns an upstream 403 access_denied into signed_out", async () => {
    const jar = await signedIn();
    server.apiReply = () => new Response(JSON.stringify({ error: "access_denied" }), { status: 403, headers: { "content-type": "application/json" } });
    const res = await post(jar, JSON.stringify(BATCH));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
  });

  it("turns an upstream redirect into 502 upstream_redirect, and a network failure into upstream_unavailable", async () => {
    const jar = await signedIn();
    server.apiReply = () => new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/x" } });
    let res = await post(jar, JSON.stringify(BATCH));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_redirect" });
    cfg.upstream = async () => {
      throw new TypeError("network down");
    };
    res = await post(jar, JSON.stringify(BATCH));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unavailable" });
  });

  it("never writes the session cookie", async () => {
    const jar = await signedIn();
    now += 5 * 60;
    const res = await post(jar, JSON.stringify(BATCH));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("refuses every method but POST with 405 naming POST", async () => {
    const jar = await signedIn();
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const res = await jar.api("sync/mutations", { method, headers: POST_HEADERS });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("POST");
    }
    expect(server.apiRequests).toHaveLength(0);
  });

  it("refuses POST on every read path with 405 naming GET", async () => {
    const jar = await signedIn();
    for (const path of ["sync/changes", "attachments/x", "tasks/T_1", "sync/info"]) {
      const res = await jar.api(path, { method: "POST", headers: POST_HEADERS, body: JSON.stringify(BATCH) });
      expect(res.status, path).toBe(405);
      expect(res.headers.get("allow"), path).toBe("GET");
    }
    expect(server.apiRequests).toHaveLength(0);
  });
});

describe("apiRoute", () => {
  it("maps an allowlisted path to /api/v1 and the one method it takes", () => {
    expect(apiRoute("tasks/abc_D-9")).toEqual({ path: "/api/v1/tasks/abc_D-9", method: "GET" });
    expect(apiRoute("sync/info")).toEqual({ path: "/api/v1/sync/info", method: "GET" });
    expect(apiRoute("sync/mutations")).toEqual({ path: "/api/v1/sync/mutations", method: "POST" });
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
      expect(apiRoute(raw), raw).toBeNull();
    }
    expect(apiRoute("tasks/" + "a".repeat(128))?.path).toBe("/api/v1/tasks/" + "a".repeat(128));
  });
});
