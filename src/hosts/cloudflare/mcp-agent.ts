import type { Connection, ConnectionContext } from "agents";
import { McpAgent } from "agents/mcp";
import { registerTools } from "../../core/mcp/register-tools";
import { createMcpServer } from "../../core/mcp/server";
import { SESSION_IDLE_MS, sessionExpiry, shouldTouch } from "../../core/mcp/session-expiry";
import type { Props } from "../../core/types";
import { appEnv } from "./env";

const LAST_ACTIVE_KEY = "session:last_active_at";

// One object per MCP session. Renamed from MSToDoMCP in migration v3, which
// deleted every session the old class had left behind.
export class MSToDoSession extends McpAgent<Env, never, Props> {
  server = createMcpServer();
  #touchedAt = 0;

  async init() {
    registerTools(this.server, { env: appEnv(this.env) });
  }

  // Runs on every wake, including the alarm's, so it only makes sure one
  // expiry check is pending (idempotent: one row, however many wakes).
  async onStart(props?: Props) {
    await super.onStart(props);
    await this.schedule(SESSION_IDLE_MS / 1000, "expireIfIdle", undefined, { idempotent: true });
  }

  // Each streamable-HTTP request reaches the object as a connection.
  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const now = Date.now();
    if (shouldTouch(this.#touchedAt, now)) {
      this.#touchedAt = now;
      await this.ctx.storage.put(LAST_ACTIVE_KEY, now);
    }
    return super.onConnect(conn, ctx);
  }

  async expireIfIdle() {
    const decision = sessionExpiry(await this.ctx.storage.get<number>(LAST_ACTIVE_KEY), Date.now());
    if (decision.expire) {
      await this.destroy();
      return;
    }
    // Not idempotent: the row that called this is still present until it returns.
    await this.schedule(decision.checkInSeconds, "expireIfIdle");
  }
}
