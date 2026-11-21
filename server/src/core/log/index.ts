import type { Redactor } from "../redact/index.ts";

const LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LEVELS)[number];

export function parseLogLevel(value: string | undefined): LogLevel {
  return LEVELS.find((level) => level === value) ?? "info";
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** The one logger: JSON lines, every one of them redacted before it is written. */
export function createLogger(options: { level: LogLevel; redactor: Redactor; write: (line: string) => void }): Logger {
  const threshold = LEVELS.indexOf(options.level);
  const at =
    (level: Exclude<LogLevel, "silent">) =>
    (message: string, fields: Record<string, unknown> = {}) => {
      if (LEVELS.indexOf(level) < threshold) return;
      options.write(options.redactor.text(JSON.stringify({ level, message, ...fields })));
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
