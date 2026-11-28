import { beforeEach, describe, expect, it, vi } from "vitest";
import { withSecurityHeaders } from "./headers.ts";
import { route } from "./router.ts";
import { TestServer } from "./test-server.ts";
import { type BffConfig, upstreamVia } from "./upstream.ts";

const WEB = "https://web.example.com";
const SERVER = "https://server.example.com";
const SECRET = "test-secret-test-secret-test-secret-0123";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
  "connect-src 'self' wss://web.example.com; " +
  `frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${SERVER}`;

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
    now: () => 1_800_000_000,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    sleep: async () => {},
  };
});

const csrf = { "x-potem": "1", origin: WEB };
const req = (path: string, init: RequestInit = {}) => new Request(new URL(path, WEB), init);

const API_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";

function expectSecurityHeaders(res: Response, label: string, noStore: boolean, csp = CSP) {
  expect(res.headers.get("content-security-policy"), label).toBe(csp);
  expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
  expect(res.headers.get("referrer-policy"), label).toBe("no-referrer");
  expect(res.headers.get("x-robots-tag"), label).toBe("noindex, nofollow");
  // This host only: no includeSubDomains or preload.
  expect(res.headers.get("strict-transport-security"), label).toBe("max-age=31536000");
  if (noStore) expect(res.headers.get("cache-control"), label).toBe("no-store");
  // Every /auth and /bff response (noStore marks those) is same-origin only.
  expect(res.headers.get("cross-origin-resource-policy"), label).toBe(noStore ? "same-origin" : null);
}

describe("route", () => {
  it("dispatches each BFF route and answers 404 or 405 for the rest of /auth and /bff", async () => {
    const cases: [string, RequestInit, number][] = [
      ["/auth/login", {}, 302],
      ["/auth/callback?state=x&code=y", {}, 400],
      ["/auth/logout", { method: "POST", headers: csrf }, 204],
      ["/bff/session", {}, 200],
      ["/bff/session/refresh", { method: "POST", headers: csrf }, 401],
      ["/bff/api/sync/info", {}, 401],
      ["/bff/api/sync/mutations", { method: "POST" }, 403],
      ["/bff/api/sync/mutations", {}, 405],
      ["/bff/api/sync/changes", { method: "POST" }, 405],
      ["/bff/api/attachments/x", { method: "POST" }, 405],
      ["/bff/api/token", { method: "POST" }, 404],
      ["/auth/login", { method: "POST" }, 405],
      ["/auth/logout", {}, 405],
      ["/bff/session", { method: "DELETE" }, 405],
      ["/bff/session/refresh", {}, 405],
      ["/bff/socket", {}, 426],
      ["/bff/socket", { method: "POST", headers: { upgrade: "websocket", origin: WEB } }, 405],
      ["/auth/other", {}, 404],
      ["/auth", {}, 404],
      ["/bff/other", {}, 404],
      ["/bff", {}, 404],
      ["/bff/api/../token", {}, 404],
      ["/bff/api/%2e%2e/token", {}, 404],
      ["/bff/api/tasks/%41", {}, 404],
    ];
    for (const [path, init, status] of cases) {
      const res = await route(req(path, init), cfg);
      const label = `${init.method ?? "GET"} ${path}`;
      expect(res?.status, label).toBe(status);
      const api = new URL(path, WEB).pathname.startsWith("/bff/api/");
      expectSecurityHeaders(res!, label, true, api ? API_CSP : CSP);
    }
    expect(server.apiRequests).toHaveLength(0);
  });

  it("names the allowed method on a 405", async () => {
    expect((await route(req("/auth/logout"), cfg))!.headers.get("allow")).toBe("POST");
    expect((await route(req("/bff/session", { method: "POST" }), cfg))!.headers.get("allow")).toBe("GET");
    expect((await route(req("/bff/socket", { method: "POST" }), cfg))!.headers.get("allow")).toBe("GET");
  });

  it("returns null for a GET /bff/socket upgrade, which the host authorizes and relays", async () => {
    for (const upgrade of ["websocket", "WebSocket"]) {
      expect(await route(req("/bff/socket", { headers: { upgrade, origin: WEB } }), cfg), upgrade).toBeNull();
    }
    expect(server.apiRequests).toHaveLength(0);
  });

  it("answers 426 naming the upgrade for a GET /bff/socket without one", async () => {
    const res = (await route(req("/bff/socket", { headers: { origin: WEB } }), cfg))!;
    expect(res.status).toBe(426);
    expect(res.headers.get("upgrade")).toBe("websocket");
  });

  it("names the allowed method on a /bff/api 405: GET for a read path, POST for sync/mutations", async () => {
    expect((await route(req("/bff/api/sync/changes", { method: "POST" }), cfg))!.headers.get("allow")).toBe("GET");
    expect((await route(req("/bff/api/attachments/x", { method: "POST" }), cfg))!.headers.get("allow")).toBe("GET");
    expect((await route(req("/bff/api/sync/mutations"), cfg))!.headers.get("allow")).toBe("POST");
  });

  it("proxies a mutation batch with the sandbox CSP and CORP on the response", async () => {
    // Sign in through the routes, keeping the cookies.
    const cookies = new Map<string, string>();
    const keep = (res: Response) => {
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(";")[0];
        const eq = pair.indexOf("=");
        cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      return res;
    };
    const withCookies = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      return req(path, { ...init, headers });
    };
    const login = keep((await route(withCookies("/auth/login"), cfg))!);
    const back = await server.authorize(login.headers.get("location")!);
    keep((await route(withCookies(new URL(back).pathname + new URL(back).search), cfg))!);

    const body = JSON.stringify({ client_id: "web-1", mutations: [{ id: "m-1", at: "2031-01-01T00:00:00Z", op: "task.delete", sid: "T_1" }] });
    const res = (await route(
      withCookies("/bff/api/sync/mutations", { method: "POST", headers: { ...csrf, "content-type": "application/json" }, body }),
      cfg,
    ))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cursor: "cursor-1", results: [{ id: "m-1", status: "applied", sid: "T_1" }] });
    expectSecurityHeaders(res, "mutations", true, API_CSP);
    expect(server.apiRequests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/v1/sync/mutations"]);
  });

  it("returns null for every other path, so static assets answer", async () => {
    for (const path of ["/", "/index.html", "/assets/app.js", "/authx", "/bffx", "/robots.txt"]) {
      expect(await route(req(path), cfg), path).toBeNull();
    }
  });

  it("answers 500 with the headers when a handler throws", async () => {
    cfg.secret = "short";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await route(req("/bff/session?code=secret-code"), cfg);
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][0])).toContain('"path":"/bff/session"');
    expect(String(log.mock.calls[0][0])).not.toContain("secret-code");
    log.mockRestore();
    expect(res!.status).toBe(500);
    expect(res!.headers.get("content-type")).toBe("application/json");
    expect(await res!.json()).toEqual({ error: "internal" });
    expectSecurityHeaders(res!, "500", true);
  });
});

describe("withSecurityHeaders", () => {
  it("gives every /bff/api response the sandbox CSP and CORP, replacing any it had", () => {
    for (const status of [200, 401, 404, 410, 502]) {
      const upstream = new Response("{}", { status, headers: { "content-security-policy": "default-src *" } });
      const res = withSecurityHeaders(upstream, cfg, "/bff/api/attachments/A_1");
      expectSecurityHeaders(res, String(status), true, API_CSP);
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    }
  });

  it("allows the push socket's own origin in connect-src: ws:// for a loopback http web origin", () => {
    const res = withSecurityHeaders(new Response(""), { ...cfg, webOrigin: "http://localhost:8787" }, "/index.html");
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self' ws://localhost:8787;");
  });

  it("adds every header to an asset response, without no-store, and keeps its own headers", async () => {
    const asset = new Response("<html></html>", { status: 200, headers: { "content-type": "text/html", etag: '"a"' } });
    const res = withSecurityHeaders(asset, cfg, "/index.html");
    expectSecurityHeaders(res, "asset", false);
    expect(res.headers.has("cache-control")).toBe(false);
    expect(res.headers.get("etag")).toBe('"a"');
    expect(await res.text()).toBe("<html></html>");
  });

  it("replaces a cache header on /auth and /bff with no-store", () => {
    const res = withSecurityHeaders(new Response(null, { headers: { "cache-control": "max-age=60" } }), cfg, "/bff/api/sync/info");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
