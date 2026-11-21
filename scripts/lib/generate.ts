import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIr, type Ir } from "../../codegen/src/ir.ts";
import serverPackage from "../../server/package.json" with { type: "json" };
import { createApp } from "../../server/src/app.ts";
import { createBearerToken } from "../../server/src/core/auth/index.ts";
import { createLogger } from "../../server/src/core/log/index.ts";
import { Redactor } from "../../server/src/core/redact/index.ts";
import { Secrets } from "../../server/src/core/secrets/index.ts";
import { secretSpecs } from "../../server/src/drivers/index.ts";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The OpenAPI document and the IR, built from the routes as they are in the working tree. */
export function specFromRoutes(): { openapi: object; ir: Ir } {
  const redactor = new Redactor();
  const app = createApp({
    version: serverPackage.version,
    token: createBearerToken(),
    seed: 0,
    secrets: Secrets.ephemeral(secretSpecs()),
    redactor,
    log: createLogger({ level: "silent", redactor, write: () => {} }),
    urls: () => ({ control: "", driver: () => "" }),
    webhooks: {},
  });
  const openapi = app.openapi();
  return { openapi, ir: buildIr(openapi) };
}

export const toJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Files below `dir`, as paths relative to the repository root. */
export function filesBelow(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

/** The paths whose committed contents differ from `expected` (path → contents). */
export function staleFiles(expected: ReadonlyMap<string, string>): string[] {
  return [...expected].filter(([path, contents]) => read(path) !== contents).map(([path]) => path);
}

function read(path: string): string | undefined {
  try {
    return readFileSync(join(ROOT, path), "utf8");
  } catch {
    return undefined;
  }
}
