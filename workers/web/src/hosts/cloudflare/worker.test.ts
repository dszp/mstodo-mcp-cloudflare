import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "../../bff/cookies.ts";
import { sealer } from "../../bff/seal.ts";
import type { Session } from "../../bff/session.ts";
import type { RelaySocket, SocketRuntime } from "./socket-relay.ts";
import worker, { type Env, handleRequest } from "./worker.ts";

const WEB = "https://web.example.com";
const SERVER = "https://server.example.com";
const SECRET = "test-secret-test-secret-test-secret-0123";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
  `frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${SERVER}`;
/** HSTS for the web host only: no includeSubDomains or preload (the zone holds other hosts). */
const HSTS = "max-age=31536000";

const ROBOTS = readFileSync(new URL("../../../public/robots.txt", import.meta.url), "utf8");

// The built public/ directory is what ASSETS serves; the fake serves the same
// robots.txt and an index.html for everything else (the SPA fallback).
function fakeAssets() {
  const calls: Request[] = [];
  return {
    calls,
    fetch: async (req: Request) => {
      calls.push(req);
      const { pathname } = new URL(req.url);
      if (pathname === "/robots.txt") return new Response(ROBOTS, { headers: { "content-type": "text/plain" } });
      return new Response("<!doctype html><title>Potem</title>", { headers: { "content-type": "text/html" } });
    },
  };
}

function fakeEnv(over: Partial<Record<keyof Env, unknown>> = {}) {
  const assets = fakeAssets();
  const env = {
    ASSETS: assets,
    SERVER_ORIGIN: SERVER,
    WEB_ORIGIN: WEB,
    WEB_SESSION_SECRET: SECRET,
    ...over,
  } as unknown as Env;
  return { env, assets };
}

const call = (env: Env, url: string, init?: RequestInit) => worker.fetch(new Request(url, init), env);

afterEach(() => vi.unstubAllGlobals());

describe("config check", () => {
  const cases: { label: string; over: Record<string, unknown>; name: string }[] = [
    { label: "SERVER_ORIGIN missing", over: { SERVER_ORIGIN: undefined }, name: "SERVER_ORIGIN" },
    { label: "SERVER_ORIGIN is the template placeholder", over: { SERVER_ORIGIN: "<your-server-origin>" }, name: "SERVER_ORIGIN" },
    { label: "SERVER_ORIGIN has a path", over: { SERVER_ORIGIN: "https://server.example.com/x" }, name: "SERVER_ORIGIN" },
    { label: "SERVER_ORIGIN is plain http", over: { SERVER_ORIGIN: "http://server.example.com" }, name: "SERVER_ORIGIN" },
    { label: "WEB_ORIGIN missing", over: { WEB_ORIGIN: undefined }, name: "WEB_ORIGIN" },
    { label: "WEB_ORIGIN not a URL", over: { WEB_ORIGIN: "web.example.com" }, name: "WEB_ORIGIN" },
    { label: "WEB_SESSION_SECRET missing", over: { WEB_SESSION_SECRET: undefined }, name: "WEB_SESSION_SECRET" },
    { label: "WEB_SESSION_SECRET under 32 bytes", over: { WEB_SESSION_SECRET: "short" }, name: "WEB_SESSION_SECRET" },
    { label: "max hours zero", over: { WEB_SESSION_MAX_HOURS: "0" }, name: "WEB_SESSION_MAX_HOURS" },
    { label: "max hours not a number", over: { WEB_SESSION_MAX_HOURS: "twelve" }, name: "WEB_SESSION_MAX_HOURS" },
    { label: "max hours fractional", over: { WEB_SESSION_MAX_HOURS: "1.5" }, name: "WEB_SESSION_MAX_HOURS" },
    { label: "idle minutes negative", over: { WEB_SESSION_IDLE_MINUTES: "-5" }, name: "WEB_SESSION_IDLE_MINUTES" },
    { label: "idle minutes empty", over: { WEB_SESSION_IDLE_MINUTES: "" }, name: "WEB_SESSION_IDLE_MINUTES" },
    { label: "icon not blue or teal", over: { WEB_ICON: "green" }, name: "WEB_ICON" },
  ];
  for (const c of cases) {
    it(`503 naming the variable, never its value: ${c.label}`, async () => {
      const { env, assets } = fakeEnv(c.over);
      for (const path of ["/", "/bff/session", "/robots.txt"]) {
        const res = await call(env, `${WEB}${path}`);
        expect(res.status, path).toBe(503);
        expect(res.headers.get("strict-transport-security"), path).toBe(HSTS);
        expect(res.headers.get("cross-origin-resource-policy"), path).toBe(path === "/bff/session" ? "same-origin" : null);
        const text = await res.text();
        expect(text, path).toContain(c.name);
        for (const v of Object.values(c.over)) {
          if (typeof v === "string" && v !== "") expect(text, path).not.toContain(v);
        }
      }
      expect(assets.calls).toHaveLength(0);
    });
  }

  it("accepts absent session limits (defaults) and valid ones", async () => {
    for (const over of [{}, { WEB_SESSION_MAX_HOURS: "24", WEB_SESSION_IDLE_MINUTES: "30" }]) {
      const res = await call(fakeEnv(over).env, `${WEB}/bff/session`);
      expect(res.status).toBe(200);
    }
  });
});

describe("host check", () => {
  it("answers 421 for a host other than WEB_ORIGIN's, with the security headers", async () => {
    const { env, assets } = fakeEnv();
    for (const url of ["https://other.example.com/", "https://other.example.com/bff/session"]) {
      const res = await call(env, url);
      expect(res.status, url).toBe(421);
      expect(res.headers.get("content-type"), url).toContain("text/plain");
      expect(res.headers.get("content-security-policy"), url).toBe(CSP);
      expect(res.headers.get("strict-transport-security"), url).toBe(HSTS);
    }
    expect(assets.calls).toHaveLength(0);
  });

  it("serves the configured host", async () => {
    expect((await call(fakeEnv().env, `${WEB}/`)).status).toBe(200);
  });
});

describe("assets", () => {
  it("falls through to ASSETS and adds the security headers, without no-store", async () => {
    const { env, assets } = fakeEnv();
    const res = await call(env, `${WEB}/lists/abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Potem");
    expect(assets.calls).toHaveLength(1);
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("strict-transport-security")).toBe(HSTS);
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("serves HEAD from assets", async () => {
    const { env, assets } = fakeEnv();
    const res = await call(env, `${WEB}/`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(assets.calls).toHaveLength(1);
  });

  it("answers 405 to other methods on asset paths, without reaching ASSETS", async () => {
    const { env, assets } = fakeEnv();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await call(env, `${WEB}/index.html`, { method, body: "x" });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET, HEAD");
      expect(res.headers.get("content-security-policy"), method).toBe(CSP);
      expect(res.headers.get("strict-transport-security"), method).toBe(HSTS);
    }
    expect(assets.calls).toHaveLength(0);
  });

  it("serves robots.txt from public/ and it disallows everything", async () => {
    expect(ROBOTS).toBe("User-agent: *\nDisallow: /\n");
    const res = await call(fakeEnv().env, `${WEB}/robots.txt`);
    expect(await res.text()).toBe(ROBOTS);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

describe("BFF routing", () => {
  it("hands /bff paths to the router", async () => {
    const { env, assets } = fakeEnv();
    const res = await call(env, `${WEB}/bff/session`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signed_in: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(assets.calls).toHaveLength(0);
  });

  it("does not hand /auth or /bff look-alikes to the router", async () => {
    const { env, assets } = fakeEnv();
    await call(env, `${WEB}/bffx`);
    await call(env, `${WEB}/authors`);
    expect(assets.calls).toHaveLength(2);
  });
});

describe("upstream", () => {
  // GET /auth/login with no device cookie registers a client at the server first.
  it("prefers the SERVER service binding over global fetch", async () => {
    const globalFetch = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", globalFetch);
    const seen: string[] = [];
    const SERVER_BINDING = {
      fetch: async (req: Request) => {
        seen.push(`${req.method} ${req.url}`);
        return new Response("{}", { status: 500 });
      },
    };
    const { env } = fakeEnv({ SERVER: SERVER_BINDING });
    await call(env, `${WEB}/auth/login`);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain(`${SERVER}/`);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("uses global fetch when no binding is set", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (req: Request) => {
      seen.push(req.url);
      return new Response("{}", { status: 500 });
    });
    await call(fakeEnv().env, `${WEB}/auth/login`);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain(`${SERVER}/`);
  });
});

describe("app icon", () => {
  const ICON_PATHS = ["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png"];

  it("serves the blue icons as they are when WEB_ICON is absent or blue", async () => {
    for (const over of [{}, { WEB_ICON: "blue" }]) {
      const { env, assets } = fakeEnv(over);
      for (const path of ICON_PATHS) await call(env, `${WEB}${path}`);
      expect(assets.calls.map((r) => new URL(r.url).pathname), JSON.stringify(over)).toEqual(ICON_PATHS);
    }
  });

  it("serves the teal set for WEB_ICON teal, with the security headers", async () => {
    const { env, assets } = fakeEnv({ WEB_ICON: "teal" });
    for (const path of ICON_PATHS) {
      const res = await call(env, `${WEB}${path}`);
      expect(res.headers.get("strict-transport-security"), path).toBe(HSTS);
    }
    expect(assets.calls.map((r) => new URL(r.url).pathname)).toEqual(
      ICON_PATHS.map((p) => `/icons/teal${p}`),
    );
  });

  it("leaves other paths alone for WEB_ICON teal", async () => {
    const { env, assets } = fakeEnv({ WEB_ICON: "teal" });
    await call(env, `${WEB}/robots.txt`);
    await call(env, `${WEB}/favicon.svg.map`);
    expect(assets.calls.map((r) => new URL(r.url).pathname)).toEqual(["/robots.txt", "/favicon.svg.map"]);
  });
});

describe("push socket", () => {
  // Only what the routing needs: the relay itself is tested in socket-relay.test.ts.
  const fakeSocket = (): RelaySocket & { closes: number[] } => {
    const closes: number[] = [];
    return { closes, accept() {}, send() {}, close: (code: number) => void closes.push(code), addEventListener() {} };
  };

  function fakeRuntime() {
    const client = fakeSocket();
    const browser = fakeSocket();
    const runtime: SocketRuntime = {
      pair: () => [client, browser],
      upgraded: () => new Response("upgraded"),
      schedule: () => () => {},
      now: () => Date.now(),
    };
    return { runtime, client, browser };
  }

  async function sessionCookie(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const session: Session = {
      access_token: "access-1",
      access_exp: now + 3600,
      refresh_token: "refresh-1",
      data_key: "data-key-1",
      created_at: now - 60,
      last_seen: now - 60,
    };
    return `${SESSION_COOKIE}=${await (await sealer(SECRET)).seal(SESSION_COOKIE, session)}`;
  }

  function fakeServer() {
    const calls: Request[] = [];
    const up = fakeSocket();
    return { calls, up, fetch: async (req: Request) => (calls.push(req), { status: 101, webSocket: up }) as unknown as Response };
  }

  it("refuses a foreign Origin without reaching the server or ASSETS", async () => {
    const globalFetch = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", globalFetch);
    const server = fakeServer();
    const { env, assets } = fakeEnv({ SERVER: server });
    const { runtime, browser } = fakeRuntime();
    const headers = { origin: "https://evil.example.com", upgrade: "websocket", cookie: await sessionCookie() };
    for (const res of [
      await handleRequest(new Request(`${WEB}/bff/socket`, { headers }), env, runtime),
      await call(env, `${WEB}/bff/socket`, { headers }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(server.calls).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(assets.calls).toHaveLength(0);
    expect(browser.closes).toEqual([]);
  });

  it("relays a valid session's upgrade to the server's socket with only the authorized headers", async () => {
    const server = fakeServer();
    const { env, assets } = fakeEnv({ SERVER: server });
    const { runtime } = fakeRuntime();
    const req = new Request(`${WEB}/bff/socket`, {
      headers: { origin: WEB, upgrade: "websocket", cookie: await sessionCookie(), "sec-websocket-protocol": "chat" },
    });
    const res = await handleRequest(req, env, runtime);
    expect(await res.text()).toBe("upgraded");
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].url).toBe(`${SERVER}/api/v1/sync/socket`);
    expect([...server.calls[0].headers]).toEqual([
      ["authorization", "Bearer access-1"],
      ["upgrade", "websocket"],
    ]);
    expect(assets.calls).toHaveLength(0);
  });

  it("uses global fetch for the socket when no binding is set", async () => {
    const server = fakeServer();
    vi.stubGlobal("fetch", server.fetch);
    const { env } = fakeEnv();
    const req = new Request(`${WEB}/bff/socket`, { headers: { origin: WEB, upgrade: "websocket", cookie: await sessionCookie() } });
    await handleRequest(req, env, fakeRuntime().runtime);
    expect(server.calls.map((r) => r.url)).toEqual([`${SERVER}/api/v1/sync/socket`]);
  });

  it("answers a non-upgrade request to /bff/socket without the relay", async () => {
    const { env, assets } = fakeEnv();
    const res = await call(env, `${WEB}/bff/socket`);
    expect(res.status).toBe(426);
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(assets.calls).toHaveLength(0);
  });
});
