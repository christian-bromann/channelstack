import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { binaryPath } from "../../../scripts/lib/packages.ts";
import {
  startBinary as startExecutable,
  type StartBinaryOptions,
  type StartedBinary,
} from "../../../scripts/lib/server.ts";

/** The compiled binary under test: `CHANNELSTACK_SERVER_BIN`, or the one `pnpm build:binary` made for this machine. */
export const BINARY = process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();

export function temporaryHome(): string {
  return mkdtempSync(join(tmpdir(), "channelstack-test-"));
}

/** Run the binary to completion. */
export function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  if (!existsSync(BINARY)) throw new Error(`No server binary at ${BINARY}. Run \`pnpm build\` first.`);
  const result = spawnSync(BINARY, args, { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export interface RunningBinary extends StartedBinary {
  /** Call the control API. Pass `token: null` to send no Authorization header. */
  control(method: string, path: string, body?: unknown, token?: string | null): Promise<{ status: number; body: any }>;
}

/** Start the binary under test with its own state directory, and add a control API client for it. */
export async function startBinary(options: Omit<StartBinaryOptions, "bin"> = {}): Promise<RunningBinary> {
  const server = await startExecutable({ bin: BINARY, ...options });
  return {
    ...server,
    async control(method, path, body, token = server.token) {
      const response = await fetch(`${server.url}/_channelstack${path}`, {
        method,
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined };
    },
  };
}
