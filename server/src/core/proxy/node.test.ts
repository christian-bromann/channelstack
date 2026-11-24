import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { nodeOptions, writeNodePreload } from "./node.ts";

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The undici Bolt loads (through `@slack/socket-mode`), as the Bolt reference agent resolves it. */
const undici = () => {
  const agent = createRequire(join(import.meta.dirname, "../../../../examples/agents/bolt-ai-sdk/agent.ts"));
  const bolt = createRequire(agent.resolve("@slack/bolt"));
  return createRequire(bolt.resolve("@slack/socket-mode")).resolve("undici");
};

/** In a Node agent's environment: which dispatcher Node's own fetch uses after the agent imports undici. */
function dispatcherAfterUndici(env: Record<string, string>): string {
  const script = `
    const v1 = Symbol.for("undici.globalDispatcher.1");
    await import(${JSON.stringify(undici())});
    console.log(globalThis[v1]?.constructor?.name);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:1", ...env },
    encoding: "utf8",
  });
  return child.stdout.trim() || child.stderr;
}

describe("proxy mode in a Node agent that loads undici", () => {
  test("without the preload, importing undici replaces Node's proxy-aware dispatcher", () => {
    expect(dispatcherAfterUndici({})).not.toBe("EnvHttpProxyAgent");
  });

  test("with it, Node's fetch keeps the proxy", () => {
    const home = mkdtempSync(join(tmpdir(), "channelstack-preload-"));
    homes.push(home);
    const preload = writeNodePreload(home);
    expect(statSync(preload).mode & 0o777).toBe(0o600);
    expect(dispatcherAfterUndici({ NODE_OPTIONS: nodeOptions(preload) })).toBe("EnvHttpProxyAgent");
  });
});
