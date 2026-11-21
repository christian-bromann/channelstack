import { expect, test } from "vitest";
import { Redactor } from "../redact/index.ts";
import { createLogger, parseLogLevel } from "./index.ts";

test("log lines are JSON, filtered by level and redacted", () => {
  const lines: string[] = [];
  const redactor = new Redactor();
  redactor.register("a-shapeless-secret");
  const log = createLogger({ level: parseLogLevel("info"), redactor, write: (line) => lines.push(line) });

  log.debug("dropped");
  log.info("started", { secret: "a-shapeless-secret", owner: "ana@example.com" });
  log.warn("careful");
  log.error("failed");

  expect(lines.map((line) => JSON.parse(line))).toEqual([
    { level: "info", message: "started", secret: "[redacted]", owner: "[redacted]" },
    { level: "warn", message: "careful" },
    { level: "error", message: "failed" },
  ]);
  expect(parseLogLevel("nonsense")).toBe("info");
  expect(parseLogLevel("silent")).toBe("silent");
});
