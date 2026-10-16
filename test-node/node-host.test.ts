import { describe, it, expect, vi, afterEach } from "vitest";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { buildNodeEnv, InvalidConfigError, MissingConfigError } from "../src/hosts/node/env";
import { backgroundTasks, createHandler, startScheduler } from "../src/hosts/node/http";
import { SCOPES, storeTokens } from "../src/core/auth/microsoft";
import { ORIGIN, oauthClient, stubMicrosoft } from "./_oauth-client";

const vars = {
  TIMEZONE: "America/New_York",
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

// JSON-RPC over the stateless Streamable HTTP endpoint, as an MCP client sends it.
function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
  return {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  };
}
function mcpHeaders(token?: string) {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

describe("node host", () => {
  it("serves /health", async () => {
    const { env } = buildNodeEnv(openDatabase(":memory:"), vars);
    const res = await createHandler(env, { publicOrigin: ORIGIN }).fetch(new Request("http://localhost/health"));
    expect(await res.json()).toMatchObject({ ok: true, service: "mstodo-mcp", host: "node" });
  });

  it("refuses to build an env without the required secrets, naming only the keys", () => {
    const err = (() => {
      try {
        buildNodeEnv(openDatabase(":memory:"), { ...vars, MS_CLIENT_SECRET: "", OWNER_EMAIL: undefined });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MissingConfigError);
    expect((err as MissingConfigError).missing).toEqual(["MS_CLIENT_SECRET", "OWNER_EMAIL"]);
  });

  it("re-arms a persisted alarm after restart", async () => {
    vi.useFakeTimers();
    const db = openDatabase(":memory:");
    const first = buildNodeEnv(db, vars);
    await first.state.setAlarm(Date.now() + 1000);
    const second = buildNodeEnv(db, vars); // simulated restart: same DB, new process objects
    const alarm = vi.spyOn(second.core, "alarm").mockResolvedValue();
    const sched = startScheduler(second.core, second.state);
    // Not early: the timer follows the persisted time, not a default.
    await vi.advanceTimersByTimeAsync(900);
    expect(alarm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(alarm).toHaveBeenCalledTimes(1);
    // Cleared before the handler ran, as on a Durable Object.
    expect(await second.state.getAlarm()).toBeNull();
    sched.stop();
  });

  it("follows an alarm the index sets while running", async () => {
    vi.useFakeTimers();
    const { core, state } = buildNodeEnv(openDatabase(":memory:"), vars);
    const alarm = vi.spyOn(core, "alarm").mockResolvedValue();
    const sched = startScheduler(core, state);
    await state.setAlarm(Date.now() + 500);
    await vi.advanceTimersByTimeAsync(600);
    expect(alarm).toHaveBeenCalledTimes(1);
    sched.stop();
  });

  it("keeps the alarm chain alive when reading the alarm fails", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { core, state } = buildNodeEnv(openDatabase(":memory:"), vars);
    const alarm = vi.spyOn(core, "alarm").mockResolvedValue();
    const sched = startScheduler(core, state);
    const realGet = state.getAlarm.bind(state);
    let failed = false;
    vi.spyOn(state, "getAlarm").mockImplementation(async () => {
      if (!failed) {
        failed = true;
        throw new Error("disk I/O error");
      }
      return realGet();
    });
    await state.setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(200); // fire() -> getAlarm rejects
    expect(failed).toBe(true);
    expect(alarm).not.toHaveBeenCalled();
    expect(error.mock.calls.some(([m]) => String(m).includes("alarm_failed"))).toBe(true);
    await state.setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(200);
    expect(alarm).toHaveBeenCalledTimes(1);
    await expect(sched.stop()).resolves.toBeUndefined();
  });

  it("coalesces concurrent refreshes into one /token call", async () => {
    const { env, core } = buildNodeEnv(openDatabase(":memory:"), vars);
    await storeTokens(env, { access_token: "a", refresh_token: "r", expires_at: 0, scope: SCOPES, obtained_at: 0 });
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ token_type: "Bearer", scope: SCOPES, expires_in: 3600, access_token: "a2", refresh_token: "r2" }),
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await Promise.all([core.getAccessToken(), core.getAccessToken(), core.refreshToken()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toMatch(/\/oauth2\/v2\.0\/token$/);
  });

  it("answers an unauthenticated POST /mcp with 401", async () => {
    const { env } = buildNodeEnv(openDatabase(":memory:"), vars);
    const res = await createHandler(env, { publicOrigin: ORIGIN }).fetch(
      new Request("https://mcp.test/mcp", { ...rpc(1, "tools/list"), headers: mcpHeaders() }),
    );
    expect(res.status).toBe(401);
  });

  it("serves MCP over a bearer from the OAuth flow, and drops it after revocation", async () => {
    stubMicrosoft(vars.OWNER_EMAIL);
    const { env, core } = buildNodeEnv(openDatabase(":memory:"), vars);
    const handler = createHandler(env, { publicOrigin: ORIGIN });
    const client = oauthClient(handler.fetch);
    const { access_token } = await client.connect();

    const call = async (id: number, method: string, params?: Record<string, unknown>) => {
      const res = await client.send("/mcp", { ...rpc(id, method, params), headers: mcpHeaders(access_token) });
      return { status: res.status, body: (await res.json()) as { result?: Record<string, unknown>; error?: unknown } };
    };

    const init = await call(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ serverInfo: { name: "mstodo-mcp" } });

    const list = await call(2, "tools/list");
    expect(list.status).toBe(200);
    expect((list.body.result!.tools as unknown[]).length).toBe(52);

    // Cache-only tool: passes the auth preflight (tokens present, no re-auth)
    // and reads the in-process index without touching Microsoft.
    const status = await call(3, "tools/call", { name: "sync_status", arguments: {} });
    expect(status.status).toBe(200);
    expect(status.body.error).toBeUndefined();
    expect(status.body.result!.isError).not.toBe(true);
    const [content] = status.body.result!.content as Array<{ text: string }>;
    expect(JSON.parse(content.text)).toMatchObject({ ok: true });

    await core.revokeAllGrants();
    const revoked = await client.send("/mcp", { ...rpc(4, "tools/list"), headers: mcpHeaders(access_token) });
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as { error: string }).error).toBe("invalid_token");
    await handler.drain();
  });

  it("takes the OAuth origin from configuration, never from the request's Host", async () => {
    const { env } = buildNodeEnv(openDatabase(":memory:"), vars);
    const res = await createHandler(env, { publicOrigin: "https://todo.example/" }).fetch(
      new Request("http://evil.example/.well-known/oauth-protected-resource/mcp", { headers: { host: "evil.example" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resource: "https://todo.example/mcp" });
  });

  it.each([
    [undefined, MissingConfigError],
    ["", MissingConfigError],
    ["not a url", InvalidConfigError],
    ["http://todo.example", InvalidConfigError],
    ["ftp://todo.example", InvalidConfigError],
  ])("refuses public origin %j", (publicOrigin, kind) => {
    const { env } = buildNodeEnv(openDatabase(":memory:"), vars);
    expect(() => createHandler(env, { publicOrigin: publicOrigin as string })).toThrow(kind);
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787", "https://todo.example/path"])(
    "accepts public origin %s",
    (publicOrigin) => {
      const { env } = buildNodeEnv(openDatabase(":memory:"), vars);
      expect(() => createHandler(env, { publicOrigin })).not.toThrow();
    },
  );

  it("answers GET and DELETE /mcp: 401 without a bearer, 405 Allow: POST with one", async () => {
    stubMicrosoft(vars.OWNER_EMAIL);
    const { env } = buildNodeEnv(openDatabase(":memory:"), vars);
    const handler = createHandler(env, { publicOrigin: ORIGIN });
    const client = oauthClient(handler.fetch);
    for (const method of ["GET", "DELETE"]) {
      expect((await client.send("/mcp", { method })).status).toBe(401);
    }
    const { access_token } = await client.connect();
    for (const method of ["GET", "DELETE"]) {
      const res = await client.send("/mcp", { method, headers: mcpHeaders(access_token) });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("acks a Graph notification at once and finishes the deferred work on drain", async () => {
    const { env, core } = buildNodeEnv(openDatabase(":memory:"), { ...vars, ENABLE_TASK_SUBSCRIPTIONS: "true" });
    let finish!: () => void;
    const onChange = vi
      .spyOn(core, "onChangeNotification")
      .mockReturnValue(new Promise((r) => (finish = () => r({ accepted: 1, rejected: 0 }))) as never);
    const handler = createHandler(env, { publicOrigin: ORIGIN });
    const res = await handler.fetch(
      new Request("https://mcp.test/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [{ subscriptionId: "s", clientState: "c", changeType: "updated", resource: "r", resourceData: { id: "t" } }],
        }),
      }),
    );
    expect(res.status).toBe(202);
    expect(onChange).toHaveBeenCalledTimes(1);
    let drained = false;
    const drain = handler.drain().then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await drain;
    expect(drained).toBe(true);
  });

  it("logs a rejected background task instead of swallowing it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bg = backgroundTasks();
    bg.waitUntil(Promise.reject(new Error("boom")));
    await bg.drain();
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({
      level: "error",
      event: "background_task_failed",
      error: "boom",
    });
  });
});
