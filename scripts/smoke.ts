/**
 * Runs the smoke scenarios through an SDK against the compiled binary (exit check 0.2).
 *
 *   node scripts/smoke.ts [--sdk typescript|python] [--bin <server binary>] [--runner <run.ts>]
 *
 * A scenario that `requires: [echo-agent]` runs against a server this script starts next to the
 * reference agent; the others run in `start` mode, where the SDK's launcher starts the binary itself.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ROOT } from "./lib/generate.ts";
import { binaryPath } from "./lib/packages.ts";
import { background, capture, eventually, freePort, run } from "./lib/process.ts";

export type Sdk = "typescript" | "python";
export const SDKS: readonly Sdk[] = ["typescript", "python"];

export interface SmokeOptions {
  sdks: readonly Sdk[];
  /** The server binary. Default: `CHANNELSTACK_SERVER_BIN`, or the one `pnpm build:binary` compiled for this machine. */
  bin?: string;
  /** The TypeScript runner. Default: the one in the repository, which resolves `channelstack` from the workspace. */
  typescriptRunner?: string;
}

const SCENARIO_DIR = join(ROOT, "scenarios", "smoke");
const AGENT = join(ROOT, "scenarios", "agents", "echo-agent.ts");

function runScenario(
  sdk: Sdk,
  options: SmokeOptions,
  file: string,
  mode: "attach" | "start",
  env: NodeJS.ProcessEnv,
): void {
  if (sdk === "typescript") {
    const runner = options.typescriptRunner ?? join(ROOT, "scenarios", "runners", "typescript", "run.ts");
    run(process.execPath, [runner, file, "--mode", mode], { env });
  } else {
    const runner = join(ROOT, "scenarios", "runners", "python", "run.py");
    run("uv", ["run", "--project", join(ROOT, "sdks", "python"), "--frozen", "python", runner, file, "--mode", mode], {
      env,
    });
  }
}

export async function runSmoke(options: SmokeOptions): Promise<void> {
  const bin = options.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
  if (!existsSync(bin)) throw new Error(`No server binary at ${bin}. Run \`pnpm build\` first.`);
  const scenarios = readdirSync(SCENARIO_DIR)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => {
      const file = join(SCENARIO_DIR, name);
      const { requires = [] } = parse(readFileSync(file, "utf8")) as { requires?: string[] };
      return { file, needsAgent: requires.includes("echo-agent") };
    });

  // A private state directory: a smoke run never touches the developer's ~/.channelstack.
  const home = mkdtempSync(join(tmpdir(), "channelstack-smoke-"));
  const base: NodeJS.ProcessEnv = { ...process.env, CHANNELSTACK_HOME: home, CHANNELSTACK_LOG_LEVEL: "warn" };
  delete base.CHANNELSTACK_URL;
  delete base.CHANNELSTACK_TOKEN;
  const stops: Array<() => Promise<void>> = [];
  try {
    const agentPort = await freePort();
    const server = background(bin, ["start", "--no-portless", "--port", "0"], {
      ...base,
      CHANNELSTACK_ECHO_WEBHOOK_URL: `http://127.0.0.1:${agentPort}/echo/events`,
    });
    stops.push(server.stop);
    await eventually("the server to start", () => {
      if (server.child.exitCode !== null || server.child.signalCode !== null)
        throw new Error(`${bin} exited before it was ready`);
      return existsSync(join(home, "server.json")) ? true : undefined;
    });

    // The agent gets its configuration the way a developer's agent does: from `channelstack env`.
    const agentEnv = Object.fromEntries(
      capture(bin, ["env"], { env: base })
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const agent = background(process.execPath, [AGENT], { ...process.env, ...agentEnv, PORT: String(agentPort) });
    stops.push(agent.stop);
    await eventually("the echo agent to listen", async () =>
      (await fetch(`http://127.0.0.1:${agentPort}/`)).ok ? true : undefined,
    );

    for (const sdk of options.sdks) {
      for (const scenario of scenarios) {
        if (scenario.needsAgent) runScenario(sdk, options, scenario.file, "attach", base);
        else runScenario(sdk, options, scenario.file, "start", { ...base, CHANNELSTACK_SERVER_BIN: bin });
      }
    }
  } finally {
    for (const stop of stops.reverse()) await stop();
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = (name: string) =>
    process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
  const sdk = flag("--sdk");
  if (sdk !== undefined && !SDKS.includes(sdk as Sdk)) throw new Error(`--sdk must be one of ${SDKS.join(", ")}`);
  const bin = flag("--bin");
  const typescriptRunner = flag("--runner");
  await runSmoke({
    sdks: sdk === undefined ? SDKS : [sdk as Sdk],
    ...(bin === undefined ? {} : { bin }),
    ...(typescriptRunner === undefined ? {} : { typescriptRunner }),
  });
}
