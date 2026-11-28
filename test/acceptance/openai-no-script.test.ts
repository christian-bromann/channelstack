import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { startBinary } from "../../scripts/lib/server.ts";

/** The stand-in tests of one config, run through the Vitest integration, unchanged: the run's exit code and output. */
function runStandIns(config: string, home: string): { status: number | null; output: string } {
  const run = spawnSync("pnpm", ["exec", "vitest", "run", "--config", config, "--reporter", "verbose"], {
    cwd: ROOT,
    env: { ...process.env, CHANNELSTACK_HOME: home, NO_COLOR: "1" },
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

/** What Vitest printed for one failed test: its block, from its `FAIL` line to the next. */
function failureOf(output: string, name: string): string {
  const block = output.split(/^\s*FAIL\s+/m).find((part) => part.split("\n", 1)[0]?.endsWith(`> ${name}`));
  if (block === undefined) throw new Error(`No failure printed for "${name}":\n${output}`);
  return block;
}

describe("the fake OpenAI's model problems fail the test, and responders answer (13.4, 13.6)", () => {
  let server: Awaited<ReturnType<typeof startBinary>>;
  // The agent's Slack endpoint, acknowledging every event: the stand-ins play the agent's model
  // calls themselves, and what Slack delivered is what attributes a call to its message.
  let endpoint: Server;
  beforeAll(async () => {
    endpoint = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.writeHead(200).end());
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const { port } = endpoint.address() as AddressInfo;
    server = await startBinary({
      bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
      env: { CHANNELSTACK_LOG_LEVEL: "warn", CHANNELSTACK_SLACK_WEBHOOK_URL: `http://127.0.0.1:${port}/slack/events` },
    });
  }, 30_000);
  afterAll(async () => {
    await server?.stop();
    endpoint?.close();
  });

  // Exit check 13.4: a model call no script answers, a list that runs out, a responder that throws
  // (or never answers) and a script problem each fail the test the same way: at once in a waiting
  // matcher (well inside a second, not at its 20s timeout), and when the session closes in a test
  // that asserts nothing. Each with the reason.
  test("every model problem fails the test, at once or when its session closes, with why", () => {
    const { status, output } = runStandIns("test/acceptance/stand-ins/openai-no-script/vitest.config.ts", server.home);
    expect(status, output).not.toBe(0);
    expect(output).toMatch(/Tests\s+9 failed \(9\)/);

    const atOnce = {
      "an unscripted call fails a waiting matcher at once": "no openai.respond(…) in this test answers this call",
      "a list that runs out fails a waiting matcher at once": "has 1 turn; call 2 arrived",
      "a responder that throws fails a waiting matcher at once": "threw: Error: no incident data in this fixture",
      "a script problem fails a waiting matcher at once":
        "called `search_incidents`, but the request offered `lookup_runbook`",
    };
    for (const [name, reason] of Object.entries(atOnce)) {
      const failure = failureOf(output, name);
      expect(failure).toContain("The model calls of this test went wrong");
      expect(failure).toContain(reason);
      const gaveUp = /the matcher gave up after (\d+)ms/.exec(failure);
      expect(gaveUp, failure).not.toBeNull();
      // The matcher polls the session's problems: it stops within a second, not at its timeout.
      expect(Number(gaveUp?.[1]), name).toBeLessThan(1000);
    }

    const atClose = {
      "an unscripted call fails a test that asserts nothing": "no openai.respond(…) in this test answers this call",
      "a list that runs out fails a test that asserts nothing": "has 1 turn; call 2 arrived",
      "a responder that throws fails a test that asserts nothing": "threw: Error: no incident data in this fixture",
      "a script problem fails a test that asserts nothing":
        "called `search_incidents`, but the request offered `lookup_runbook`",
      "a responder that never answers fails the test with its reason": "the test didn't answer the model call held for",
    };
    for (const [name, reason] of Object.entries(atClose)) {
      const failure = failureOf(output, name);
      expect(failure).toMatch(/The model calls of this test went wrong:\n {2}\S/);
      expect(failure).toContain(reason);
    }
  }, 120_000);

  // Exit check 13.6, TypeScript: a responder answers from the request and its context, and
  // firstToken still holds when the responder is slow.
  test("responders answer from the request and its context, on time", () => {
    const { status, output } = runStandIns("test/acceptance/stand-ins/openai-responders/vitest.config.ts", server.home);
    expect(status, output).toBe(0);
    expect(output).toMatch(/Tests\s+3 passed \(3\)/);
  }, 120_000);
});
