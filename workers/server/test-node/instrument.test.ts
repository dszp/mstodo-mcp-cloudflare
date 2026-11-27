// instrument() (packages/core/observability/instrument.ts): one log event per MCP
// tool call. A failure is logged by its reason code only, because failure
// payloads can carry Graph error bodies and echoed user input.
import { afterEach, describe, it, expect, vi } from "vitest";
import { errResponse, extractFailureFields, instrument } from "@potem/core/observability/instrument";

function captureLogs() {
  const lines: string[] = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  }
  return lines;
}
afterEach(() => vi.restoreAllMocks());

describe("instrument", () => {
  it("returns a successful response unchanged", async () => {
    captureLogs();
    const res = { content: [{ type: "text" as const, text: '{"ok":true}' }] };
    expect(await instrument("get_task", async () => res)).toBe(res);
  });

  it("logs a failure's reason and never its payload", async () => {
    const lines = captureLogs();
    const res = errResponse("graph_400", { detail: "Invalid title: Buy SECRET-VALUE", task_title: "SECRET-VALUE" });
    expect(await instrument("update_task", async () => res)).toBe(res);
    const all = lines.join("\n");
    expect(all).toContain("graph_400");
    expect(all).toContain("update_task");
    expect(all).not.toContain("SECRET-VALUE");
  });

  it("turns a throw into an unexpected_error response", async () => {
    captureLogs();
    const res = await instrument("create_task", async () => {
      throw new Error("kaboom");
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ ok: false, reason: "unexpected_error", message: "kaboom" });
  });
});

describe("extractFailureFields", () => {
  it("returns the fields of an ok:false payload without ok", () => {
    expect(extractFailureFields(errResponse("x", { a: 1 }))).toEqual({ reason: "x", a: 1 });
  });

  it("returns {} for success, plain text, and no text block", () => {
    expect(extractFailureFields({ content: [{ type: "text", text: '{"ok":true}' }] })).toEqual({});
    expect(extractFailureFields({ content: [{ type: "text", text: "plain" }] })).toEqual({});
    expect(extractFailureFields({ content: [{ type: "image", data: "", mimeType: "image/png" }] })).toEqual({});
  });
});
