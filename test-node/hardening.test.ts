import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { sqliteKv, sweepKv } from "../src/hosts/node/sqlite-kv";
import { buildNodeEnv } from "../src/hosts/node/env";
import { createHandler, startScheduler } from "../src/hosts/node/http";
import { bodyCapFor, KiB, MiB } from "../src/hosts/node/body-limit";
import { installProcessHandlers, withTimeout } from "../src/hosts/node/lifecycle";
import { oauthProviderOptions } from "../src/hosts/shared/oauth";
import { UPLOAD_BODY_MAX_BYTES } from "../src/core/upload/handler";
import { SCOPES, storeTokens } from "../src/core/auth/microsoft";
import { createUploadCapability } from "../src/core/upload/tokens";
import { ORIGIN } from "./_oauth-client";

const vars = {
  TIMEZONE: "UTC",
  MS_TENANT_ID: "test-tenant",
  MS_CLIENT_ID: "test-client",
  MS_CLIENT_SECRET: "test-secret",
  OWNER_EMAIL: "test-owner@example.com",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function handler() {
  const { env } = buildNodeEnv(openDatabase(":memory:"), vars);
  return createHandler(env, { publicOrigin: ORIGIN });
}

// An endless body that counts how many chunks were pulled from it, so a test
// can show the host stopped reading instead of buffering the whole thing.
function endlessBody(chunkBytes = 16 * KiB) {
  const stats = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(ctl) {
        stats.pulls++;
        ctl.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, stats };
}

describe("request body caps (Node host)", () => {
  it("assigns each route its cap", () => {
    expect(bodyCapFor("/register")).toBe(64 * KiB);
    expect(bodyCapFor("/token")).toBe(64 * KiB);
    expect(bodyCapFor("/authorize")).toBe(64 * KiB);
    expect(bodyCapFor("/auth/microsoft/callback")).toBe(64 * KiB);
    expect(bodyCapFor("/.well-known/oauth-authorization-server")).toBe(64 * KiB);
    expect(bodyCapFor("/webhook")).toBe(64 * KiB);
    expect(bodyCapFor("/mcp")).toBe(4 * MiB);
    expect(bodyCapFor("/upload")).toBe(UPLOAD_BODY_MAX_BYTES);
    expect(bodyCapFor("/anything-else")).toBe(1 * MiB);
  });

  it.each(["/register", "/token", "/webhook", "/mcp", "/upload?t=x"])(
    "answers 413 to a declared Content-Length over the cap on %s",
    async (path) => {
      const cap = bodyCapFor(new URL(path, ORIGIN).pathname);
      const res = await handler().fetch(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: { "content-length": String(cap + 1), "content-type": "multipart/form-data; boundary=x" },
        }),
      );
      expect(res.status).toBe(413);
    },
  );

  it.each(["/register", "/token"])("stops reading a chunked body past the cap on %s", async (path) => {
    const { body, stats } = endlessBody();
    const res = await handler().fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": path === "/token" ? "application/x-www-form-urlencoded" : "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(stats.cancelled).toBe(true);
    // 64 KiB cap / 16 KiB chunks: a handful of pulls, not an unbounded read.
    expect(stats.pulls).toBeLessThanOrEqual(8);
  });

  // Core's handler buffers the whole form before it can read a token from the
  // body; the Node host refuses a token-less POST before touching the body.
  it.each([
    ["no ?t=, no Content-Length", "/upload", {}],
    ["no ?t=, 50 MiB declared", "/upload", { "content-length": String(50 * MiB) }],
    ["empty ?t=, 50 MiB declared", "/upload?t=", { "content-length": String(50 * MiB) }],
  ])("refuses a token-less /upload POST without reading the body (%s)", async (_label, path, headers) => {
    const { body, stats } = endlessBody();
    const res = await handler().fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x", ...headers },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(stats.pulls).toBe(0);
    expect(stats.cancelled).toBe(false);
  });

  it("still attaches a file uploaded with a valid link token", async () => {
    const { env } = buildNodeEnv(openDatabase(":memory:"), vars);
    await storeTokens(env, {
      access_token: "a",
      refresh_token: "r",
      expires_at: Date.now() + 3_600_000,
      scope: SCOPES,
      obtained_at: Date.now(),
    });
    const { token } = await createUploadCapability(env, { list_id: "L1", task_id: "T1" });
    const graph = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (url.includes("/attachments") && method === "GET") return Response.json({ value: [] });
      if (url.includes("/attachments") && method === "POST") {
        return Response.json({ "@odata.type": "#microsoft.graph.taskFileAttachment", id: "att-1", name: "note.txt", size: 5, contentType: "text/plain" }, { status: 201 });
      }
      return new Response("unscripted", { status: 404 });
    });
    vi.stubGlobal("fetch", graph);
    const form = new FormData();
    form.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
    const res = await createHandler(env, { publicOrigin: ORIGIN }).fetch(
      new Request(`${ORIGIN}/upload?t=${encodeURIComponent(token)}`, { method: "POST", body: form }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(graph.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true);
  });

  it("leaves a normal request alone", async () => {
    const res = await handler().fetch(
      new Request(`${ORIGIN}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:9/cb"], token_endpoint_auth_method: "none" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toHaveProperty("client_id");
  });
});

describe("KV sweep", () => {
  it("sweepKv deletes expired rows in every namespace and keeps live ones", async () => {
    let t = 1_000_000;
    const db = openDatabase(":memory:");
    const a = sqliteKv(db, "A", () => t);
    const b = sqliteKv(db, "B", () => t);
    await a.put("old", "v", { expirationTtl: 60 });
    await b.put("old", "v", { expirationTtl: 60 });
    await b.put("forever", "v");
    t += 61_000;
    sweepKv(db, () => t);
    const rows = db.prepare("SELECT ns, key FROM kv ORDER BY ns, key").all();
    expect(rows).toEqual([{ ns: "B", key: "forever" }]);
  });

  it("runs the host maintenance on the 15-minute heartbeat", async () => {
    vi.useFakeTimers();
    const db = openDatabase(":memory:");
    const { env, core, state } = buildNodeEnv(db, vars);
    vi.spyOn(core, "ensureSyncing").mockResolvedValue();
    await env.OAUTH_KV.put("code:x", "v", { expirationTtl: 60 });
    const sched = startScheduler(core, state, { maintenance: () => sweepKv(db) });
    const count = () => (db.prepare("SELECT count(*) n FROM kv").get() as { n: number }).n;
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(count()).toBe(1); // expired, but not yet swept
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count()).toBe(0);
    await sched.stop();
  });
});

describe("alarm retry (Node host)", () => {
  it("re-arms about 60 s out after alarm() fails, as Cloudflare retries a failed alarm", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { core, state } = buildNodeEnv(openDatabase(":memory:"), vars);
    const alarm = vi.spyOn(core, "alarm").mockRejectedValueOnce(new Error("graph down")).mockResolvedValue();
    const sched = startScheduler(core, state);
    await state.setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(200);
    expect(alarm).toHaveBeenCalledTimes(1);
    const next = await state.getAlarm();
    expect(next).not.toBeNull();
    expect(next! - Date.now()).toBeGreaterThan(50_000);
    expect(next! - Date.now()).toBeLessThanOrEqual(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(alarm).toHaveBeenCalledTimes(2);
    await sched.stop();
  });

  it("keeps the alarm a failed run already set instead of replacing it", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { core, state } = buildNodeEnv(openDatabase(":memory:"), vars);
    vi.spyOn(core, "alarm").mockImplementationOnce(async () => {
      await state.setAlarm(Date.now() + 5_000);
      throw new Error("late failure");
    });
    const sched = startScheduler(core, state);
    await state.setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(200);
    const next = await state.getAlarm();
    expect(next! - Date.now()).toBeLessThanOrEqual(5_000);
    await sched.stop();
  });
});

describe("process lifecycle", () => {
  function fakeProcess() {
    const proc = new EventEmitter() as EventEmitter & { exit: ReturnType<typeof vi.fn> };
    proc.exit = vi.fn();
    return proc;
  }

  it("releases the instance lock on exit", () => {
    const proc = fakeProcess();
    const release = vi.fn();
    installProcessHandlers({ release }, proc as never);
    proc.emit("exit", 0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("logs an unhandled rejection and keeps running", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const proc = fakeProcess();
    installProcessHandlers({ release: vi.fn() }, proc as never);
    proc.emit("unhandledRejection", new Error("stray"));
    expect(proc.exit).not.toHaveBeenCalled();
    expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({ event: "unhandled_rejection", error: "stray" });
  });

  it("logs an uncaught exception and exits 1", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const proc = fakeProcess();
    installProcessHandlers({ release: vi.fn() }, proc as never);
    proc.emit("uncaughtException", new Error("listen EADDRINUSE"));
    expect(proc.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({ event: "uncaught_exception" });
  });

  it("withTimeout gives up on a promise that never settles", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const p = withTimeout(new Promise(() => {}), 1000, onTimeout);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBeUndefined();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("oauth_error log", () => {
  it("logs the code, status and reason but never the library's detail", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const opts = oauthProviderOptions({ origin: ORIGIN, mcpHandler: { fetch: async () => new Response() }, toAppEnv: (e) => e as never });
    opts.onError!({
      code: "invalid_grant",
      description: "Invalid authorization code",
      status: 400,
      headers: {},
      internal: { category: "authorization-code-grant", reason: "code_invalid", detail: { code: "SECRET-CODE" } },
    });
    const line = String(warn.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({
      level: "warn",
      event: "oauth_error",
      status: 400,
      code: "invalid_grant",
      category: "authorization-code-grant",
      reason: "code_invalid",
    });
    expect(line).not.toContain("SECRET-CODE");
  });
});

describe("sqlite pragmas", () => {
  it("opens the database with synchronous = NORMAL", () => {
    const db = openDatabase(":memory:");
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
  });
});

describe("refresh failures on Node", () => {
  it("a failed refresh rejects to its caller without an unhandled rejection", async () => {
    const { env, core } = buildNodeEnv(openDatabase(":memory:"), vars);
    await storeTokens(env, { access_token: "a", refresh_token: "r", expires_at: 0, scope: SCOPES, obtained_at: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    const stray = vi.fn();
    process.on("unhandledRejection", stray);
    try {
      await expect(env.ownerIndex().refreshToken()).rejects.toThrow(/microsoft_token_503/);
      await expect(core.forceSubstrateRefresh()).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 20));
      expect(stray).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", stray);
    }
  });
});
