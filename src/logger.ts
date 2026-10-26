/**
 * Minimal structured console logger.
 *
 * Every line is prefixed with an ISO timestamp and a level so the output is
 * easy to grep while running the prototype. No external logging deps on
 * purpose — this is an MVP.
 */

type LogLevel = "INFO" | "WARN" | "ERROR";

function emit(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const parts = [new Date().toISOString(), level, event];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${format(value)}`);
  }

  const line = parts.join(" ");
  if (level === "ERROR") {
    console.error(line);
  } else if (level === "WARN") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function format(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

export const log = {
  info: (event: string, fields?: Record<string, unknown>) => emit("INFO", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("WARN", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("ERROR", event, fields),
};
