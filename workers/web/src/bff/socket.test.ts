import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "./cookies.ts";
import { sealer } from "./seal.ts";
import type { Session } from "./session.ts";
import { authorizeSocket } from "./socket.ts";
import type { BffConfig } from "./upstream.ts";

const WEB = "https://web.example.com";
const SERVER = "https://server.example.com";
const SECRET = "test-secret-test-secret-test-secret-0123";
const NOW = 1_800_000_000;

let cfg: BffConfig;
let upstreamCalls: number;

beforeEach(() => {
  upstreamCalls = 0;
  cfg = {
    webOrigin: WEB,
    serverOrigin: SERVER,
    secret: SECRET,
    maxHours: 12,
    idleMinutes: 60,
    upstream: async () => {
      upstreamCalls++;
      return new Response(null, { status: 500 });
    },
    now: () => NOW,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    sleep: async () => {},
  };
});

const SESSION: Session = {
  access_token: "access-1",
  access_exp: NOW + 3600,
  refresh_token: "refresh-1",
  data_key: "data-key-1",
  created_at: NOW - 60,
  last_seen: NOW - 60,
};

async function cookieFor(session: Session): Promise<string> {
  return `${SESSION_COOKIE}=${await (await sealer(SECRET)).seal(SESSION_COOKIE, session)}`;
}

type Opts = { method?: string; origin?: string | null; upgrade?: string | null; cookie?: string | null; extra?: Record<string, string> };

async function socketRequest(opts: Opts = {}, session: Session | null = SESSION): Promise<Request> {
  const headers = new Headers(opts.extra);
  const origin = opts.origin === undefined ? WEB : opts.origin;
  const upgrade = opts.upgrade === undefined ? "websocket" : opts.upgrade;
  const cookie = opts.cookie === undefined ? (session ? await cookieFor(session) : null) : opts.cookie;
  if (origin !== null) headers.set("origin", origin);
  if (upgrade !== null) headers.set("upgrade", upgrade);
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request(new URL("/bff/socket", WEB), { method: opts.method ?? "GET", headers });
}

async function refused(req: Request) {
  const r = await authorizeSocket(req, cfg);
  if (r.kind !== "refuse") throw new Error(`expected a refusal, got ${r.kind}`);
  return r.response;
}

function expectRefusalHeaders(res: Response, label: string) {
  expect(res.headers.get("cache-control"), label).toBe("no-store");
  expect(res.headers.get("cross-origin-resource-policy"), label).toBe("same-origin");
  expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
  expect(res.headers.get("referrer-policy"), label).toBe("no-referrer");
  expect(res.headers.get("content-security-policy"), label).toContain("frame-ancestors 'none'");
  expect(res.headers.get("strict-transport-security"), label).toBe("max-age=31536000");
}

const clearsSession = (res: Response) => res.headers.getSetCookie().some((l) => l.startsWith(`${SESSION_COOKIE}=`) && l.includes("Max-Age=0"));

describe("authorizeSocket", () => {
  it("carries closeAt: the end of the idle period, in epoch ms, when that comes first", async () => {
    const r = await authorizeSocket(await socketRequest(), cfg);
    if (r.kind !== "open") throw new Error(r.kind);
    expect(r.closeAt).toBe((NOW - 60 + 60 * 60) * 1000);
  });

  it("carries closeAt: the absolute end when that comes first", async () => {
    cfg.maxHours = 1;
    const session = { ...SESSION, created_at: NOW - 1800, last_seen: NOW };
    const r = await authorizeSocket(await socketRequest({}, session), cfg);
    if (r.kind !== "open") throw new Error(r.kind);
    expect(r.closeAt).toBe((NOW + 1800) * 1000);
  });

  it("carries closeAt: the Access token's expiry when that comes first", async () => {
    const session = { ...SESSION, cf_access_token: "cf-1", cf_access_exp: NOW + 600 };
    const r = await authorizeSocket(await socketRequest({}, session), cfg);
    if (r.kind !== "open") throw new Error(r.kind);
    expect(r.closeAt).toBe((NOW + 600) * 1000);
  });

  it("opens with exactly Upgrade and Authorization for a valid session", async () => {
    const r = await authorizeSocket(await socketRequest(), cfg);
    expect(r.kind).toBe("open");
    if (r.kind !== "open") return;
    expect(r.path).toBe("/api/v1/sync/socket");
    expect([...r.headers]).toEqual([
      ["authorization", "Bearer access-1"],
      ["upgrade", "websocket"],
    ]);
  });

  it("adds cf-access-token when the session has one", async () => {
    const session = { ...SESSION, cf_access_token: "access-jwt-1", cf_access_exp: NOW + 3600 };
    const r = await authorizeSocket(await socketRequest({}, session), cfg);
    if (r.kind !== "open") throw new Error(r.kind);
    expect([...r.headers]).toEqual([
      ["authorization", "Bearer access-1"],
      ["cf-access-token", "access-jwt-1"],
      ["upgrade", "websocket"],
    ]);
  });

  it("copies nothing from the browser's request upstream: no cookie, no other header", async () => {
    const req = await socketRequest({
      extra: {
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-protocol": "chat",
        "x-forwarded-for": "192.0.2.1",
        authorization: "Bearer browser-token",
        "cf-access-token": "browser-access-token",
      },
    });
    expect(req.headers.get("cookie")).toContain(SESSION_COOKIE);
    const r = await authorizeSocket(req, cfg);
    if (r.kind !== "open") throw new Error(r.kind);
    expect(r.headers.get("cookie")).toBeNull();
    expect([...r.headers.keys()]).toEqual(["authorization", "upgrade"]);
    expect(r.headers.get("authorization")).toBe("Bearer access-1");
  });

  it("accepts the Upgrade value in any case", async () => {
    expect((await authorizeSocket(await socketRequest({ upgrade: "WebSocket" }), cfg)).kind).toBe("open");
  });

  it("refuses a foreign Origin with 403 before reading the session", async () => {
    for (const origin of ["https://evil.example.com", "http://web.example.com", `${WEB}/`, "null", WEB.toUpperCase()]) {
      const res = await refused(await socketRequest({ origin }));
      expect(res.status, origin).toBe(403);
      expect(await res.json(), origin).toEqual({ error: "forbidden" });
      expectRefusalHeaders(res, origin);
      expect(res.headers.getSetCookie(), origin).toEqual([]);
    }
  });

  it("checks Origin before the session: a foreign Origin with a bad session cookie gets 403, no Set-Cookie", async () => {
    const res = await refused(await socketRequest({ origin: "https://evil.example.com", cookie: `${SESSION_COOKIE}=garbage` }, null));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("refuses a missing Origin with 403", async () => {
    const res = await refused(await socketRequest({ origin: null }));
    expect(res.status).toBe(403);
    expectRefusalHeaders(res, "no origin");
  });

  it("refuses a request without Upgrade: websocket with 426 naming the upgrade", async () => {
    for (const upgrade of [null, "h2c"]) {
      const res = await refused(await socketRequest({ upgrade }));
      expect(res.status, String(upgrade)).toBe(426);
      expect(res.headers.get("upgrade"), String(upgrade)).toBe("websocket");
      expect(await res.json()).toEqual({ error: "upgrade_required" });
      expectRefusalHeaders(res, String(upgrade));
    }
  });

  it("refuses every method but GET with 405 Allow: GET", async () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
      const res = await refused(await socketRequest({ method }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET");
      expectRefusalHeaders(res, method);
    }
  });

  it("answers session_refresh_needed for a session due for refresh", async () => {
    const res = await refused(await socketRequest({}, { ...SESSION, access_exp: NOW + 30 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "session_refresh_needed" });
    expect(res.headers.getSetCookie()).toEqual([]);
    expectRefusalHeaders(res, "refresh");
  });

  it("answers signed_out and clears the cookie for an expired session", async () => {
    const cases: [string, Session][] = [
      ["idle", { ...SESSION, last_seen: NOW - 60 * 60 }],
      ["absolute", { ...SESSION, created_at: NOW - 12 * 3600 }],
      ["access token", { ...SESSION, cf_access_token: "access-jwt-1", cf_access_exp: NOW }],
    ];
    for (const [label, session] of cases) {
      const res = await refused(await socketRequest({}, session));
      expect(res.status, label).toBe(401);
      expect(await res.json(), label).toEqual({ error: "signed_out" });
      expect(clearsSession(res), label).toBe(true);
      expectRefusalHeaders(res, label);
    }
  });

  it("answers signed_out without clearing when no session cookie was sent", async () => {
    const res = await refused(await socketRequest({}, null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed_out" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("answers signed_out and clears a session cookie that doesn't unseal", async () => {
    const res = await refused(await socketRequest({ cookie: `${SESSION_COOKIE}=garbage` }, null));
    expect(res.status).toBe(401);
    expect(clearsSession(res)).toBe(true);
  });

  it("never calls upstream", async () => {
    await authorizeSocket(await socketRequest(), cfg);
    await authorizeSocket(await socketRequest({ origin: "https://evil.example.com" }), cfg);
    await authorizeSocket(await socketRequest({}, null), cfg);
    expect(upstreamCalls).toBe(0);
  });
});
