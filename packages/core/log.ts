type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const payload = { level, event, ...fields };
  const json = JSON.stringify(payload);
  if (level === "error") console.error(json);
  else if (level === "warn") console.warn(json);
  else if (level === "info") console.info(json);
  else console.debug(json);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
