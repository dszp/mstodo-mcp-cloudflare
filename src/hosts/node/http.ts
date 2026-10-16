import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AlarmScheduler, StateStore } from "../../core/ports";
import type { IndexCore } from "../../core/index/index-core";
import { registerTools } from "../../core/mcp/register-tools";
import { handleUpload } from "../../core/upload/handler";
import { handleDownload } from "../../core/upload/download-handler";
import { handleWebhook } from "../../core/subscriptions/webhook-handler";
import { VERSION } from "../../core/version";
import { log } from "../../core/log";
import { oauthProviderOptions, type McpHandler } from "../shared/oauth";
import type { ProviderEnv } from "../shared/auth-handler";
import { parsePublicOrigin, type NodeEnv } from "./env";

type ProviderNodeEnv = NodeEnv & ProviderEnv;

// MCP over Streamable HTTP, stateless: a fresh server + transport per request.
// Registering the tools is cheap and the Node host keeps no session state, so
// nothing outlives the request. The grant check already ran in front of this
// (the apiHandler in oauthProviderOptions, with this request's ctx.props).
const nodeMcpHandler: McpHandler<ProviderNodeEnv> = {
  async fetch(req, env) {
    // Stateless: no server-to-client SSE stream (GET) and no session to end
    // (DELETE). Answering 405 here, after the grant check, keeps clients from
    // reconnect-looping on a stream that would close at once.
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const server = new McpServer({ name: "mstodo-mcp", version: VERSION });
    registerTools(server, { env });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      await server.close();
    }
  },
};

// The Node stand-in for ExecutionContext.waitUntil. A rejected background
// promise is logged, never swallowed and never an unhandled rejection (which
// would kill the process). drain() lets tests and shutdown wait for the work.
export function backgroundTasks() {
  const pending = new Set<Promise<void>>();
  return {
    waitUntil(p: Promise<unknown>): void {
      const tracked: Promise<void> = p.then(
        () => undefined,
        (e: unknown) => log.error("background_task_failed", { error: e instanceof Error ? e.message : String(e) }),
      );
      pending.add(tracked);
      void tracked.finally(() => pending.delete(tracked));
    },
    async drain(): Promise<void> {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}

// Every request is rewritten to the configured public origin before routing.
// The OAuth resource, the Microsoft callback URL and the consent cookies all
// derive from the request origin, which @hono/node-server builds from the
// client's Host header; behind a TLS proxy it is also http://<internal host>.
function atOrigin(req: Request, origin: string): Request {
  const url = new URL(req.url);
  const target = new URL(url.pathname + url.search, origin);
  if (target.href === url.href) return req;
  return new Request(target, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: req.signal,
    redirect: req.redirect,
    duplex: "half",
  } as RequestInit);
}

// Same routing order as the Worker (src/hosts/cloudflare/worker.ts): /health,
// the three public capability/webhook endpoints, then the OAuth provider, which
// owns /authorize, /token, /register, /.well-known/* and the /mcp grant gate.
// publicOrigin is required (SERVICE_BASE_URL in main.ts): throws
// MissingConfigError / InvalidConfigError unless it is https or loopback http.
export function createHandler(env: NodeEnv, options: { publicOrigin: string }) {
  const background = backgroundTasks();
  const publicOrigin = parsePublicOrigin(options.publicOrigin);

  async function fetch(incoming: Request): Promise<Response> {
    const req = atOrigin(incoming, publicOrigin);
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "mstodo-mcp", version: VERSION, host: "node" });
    }

    // A fresh ctx per request: the OAuth library writes the token's grant
    // props to ctx.props and the /mcp gate reads them back. A shared ctx would
    // let a concurrent request's props replace this one's between the two.
    const ctx = { waitUntil: background.waitUntil, passThroughOnException() {} } as unknown as ExecutionContext;

    const early =
      (await handleUpload(req, env)) ?? (await handleDownload(req, env)) ?? (await handleWebhook(req, env, ctx));
    if (early) return early;

    // Built per request, as on the Worker: the resource is this request's
    // origin. The env is a per-request copy because the library caches its
    // helpers on env.OAUTH_PROVIDER, which would otherwise pin the first
    // request's provider (and origin) for the life of the process.
    const provider = new OAuthProvider<ProviderNodeEnv>(
      oauthProviderOptions<ProviderNodeEnv>({ origin: url.origin, mcpHandler: nodeMcpHandler, toAppEnv: (e) => e }),
    );
    return provider.fetch(req, { ...env } as ProviderNodeEnv, ctx);
  }

  return { fetch, drain: background.drain };
}

// The Durable Object alarm and the Cloudflare cron, in one process: a timer
// follows the persisted alarm (so a restart picks it up), and a 15-minute
// heartbeat calls ensureSyncing() like the */15 cron.
export function startScheduler(
  core: Pick<IndexCore, "alarm" | "ensureSyncing">,
  state: StateStore & AlarmScheduler & { onAlarmChange(cb: (at: number | null) => void): void },
) {
  // setTimeout overflows past 2^31-1 ms (~24.8 days) and fires at once; a
  // longer alarm is reached in steps, re-reading the persisted time each wake.
  const MAX_DELAY_MS = 2 ** 31 - 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  // Alarms never overlap, as on a Durable Object: each run waits for the last.
  let running: Promise<void> = Promise.resolve();

  const arm = (at: number | null) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (at === null || stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      // The chain must stay fulfilled: a rejected link would skip every later
      // alarm and surface as an unhandled rejection (fatal in Node).
      running = running.then(fire).catch((e: unknown) =>
        log.error("alarm_failed", { error: e instanceof Error ? e.message : String(e) }),
      );
    }, Math.min(Math.max(0, at - Date.now()), MAX_DELAY_MS));
  };

  async function fire(): Promise<void> {
    const at = await state.getAlarm();
    if (stopped || at === null) return;
    if (at > Date.now()) return arm(at);
    // As on a Durable Object, the alarm is cleared before the handler runs;
    // alarm() re-arms it by calling setAlarm, which reaches arm() above.
    await state.deleteAlarm();
    await core.alarm().catch((e: unknown) =>
      log.error("alarm_failed", { error: e instanceof Error ? e.message : String(e) }),
    );
  }

  // The startup read is async; a setAlarm that lands before it resolves is
  // newer than what it read, so the read must not overwrite it.
  let changedSinceStart = false;
  state.onAlarmChange((at) => {
    changedSinceStart = true;
    arm(at);
  });
  state.getAlarm().then((at) => changedSinceStart || arm(at), (e: unknown) =>
    log.error("alarm_read_failed", { error: e instanceof Error ? e.message : String(e) }),
  );
  const heartbeat = setInterval(() => {
    core.ensureSyncing().catch((e: unknown) =>
      log.error("heartbeat_failed", { error: e instanceof Error ? e.message : String(e) }),
    );
  }, 15 * 60_000);

  return {
    // Resolves once an alarm already running has finished, so shutdown can
    // close the database after it.
    stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(heartbeat);
      return running;
    },
  };
}
