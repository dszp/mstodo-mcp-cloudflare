import { log } from "../log";

// MCP tool content blocks. Most tools return a single text block (JSON payload);
// get_attachment additionally returns an `image` block for image attachments so
// clients render them inline instead of decoding base64 out of the JSON text.
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type McpResponse = {
  content: McpContentBlock[];
  isError?: boolean;
};

export function extractFailureFields(res: McpResponse): Record<string, unknown> {
  const block = res.content.find((c): c is { type: "text"; text: string } => c.type === "text");
  const text = block?.text;
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
