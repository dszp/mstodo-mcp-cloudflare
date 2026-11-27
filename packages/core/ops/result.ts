export type ToolOk<T> = { ok: true; value: T };
export type ToolErr = { ok: false; reason: string; [k: string]: unknown };
export type ToolResult<T> = ToolOk<T> | ToolErr;

export const ok = <T>(value: T): ToolOk<T> => ({ ok: true, value });
export const err = (reason: string, extra: Record<string, unknown> = {}): ToolErr => ({
  ok: false,
  reason,
  ...extra,
});
