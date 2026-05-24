import { log } from "../log";

export type McpResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function extractFailureFields(res: McpResponse): Record<string, unknown> {
  const text = res.content[0]?.text;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.ok === false) {
      const { ok: _ok, ...rest } = parsed as Record<string, unknown>;
      return rest;
    }
  } catch {
    // not JSON — caller used okText with a plain string
  }
  return {};
}

export function errResponse(reason: string, extra: Record<string, unknown> = {}): McpResponse {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, reason, ...extra }) }],
    isError: true,
  };
}

export async function instrument(
  name: string,
  fn: () => Promise<McpResponse>,
): Promise<McpResponse> {
  const started = Date.now();
  try {
    const res = await fn();
    const durationMs = Date.now() - started;
    if (res.isError) {
      log.info("tool", { name, durationMs, ok: false, ...extractFailureFields(res) });
    } else {
      log.debug("tool", { name, durationMs, ok: true });
    }
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("tool_unexpected", { name, durationMs: Date.now() - started, message });
    return errResponse("unexpected_error", { message });
  }
}
