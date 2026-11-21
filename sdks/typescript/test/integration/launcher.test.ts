import { existsSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { BINARY, type RunningBinary, startBinary, temporaryHome } from "../../../../server/test/integration/harness.ts";
import { launch, type ServerConnection } from "../../runtime/launcher.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const status = (server: ServerConnection) =>
  fetch(`${server.url}/_channelstack/status`, { headers: { authorization: `Bearer ${server.token}` } }).then(
    (response) => response.status,
  );

async function running(): Promise<RunningBinary> {
  const server = await startBinary();
  cleanups.push(() => server.stop());
  return server;
}

describe("launcher", () => {
  test("auto and attach use the running server from server.json and never stop it", async () => {
    const server = await running();
    for (const mode of ["auto", "attach"] as const) {
      const attached = await launch({ mode }, { CHANNELSTACK_HOME: server.home });
      expect(attached).toMatchObject({ url: server.url, token: server.token });
      await attached.stop();
      expect(await status(attached)).toBe(200);
    }
  });

  test("an explicit URL takes its token from CHANNELSTACK_TOKEN or the matching server.json", async () => {
    const server = await running();
    const empty = temporaryHome();
    const viaEnv = await launch(
      { mode: "attach", server: server.url },
      { CHANNELSTACK_HOME: empty, CHANNELSTACK_TOKEN: server.token },
    );
    expect(await status(viaEnv)).toBe(200);
    const viaFile = await launch({ mode: "attach" }, { CHANNELSTACK_HOME: server.home, CHANNELSTACK_URL: server.url });
    expect(viaFile.token).toBe(server.token);
    await expect(launch({ mode: "attach", server: server.url }, { CHANNELSTACK_HOME: empty })).rejects.toThrow(
      /No running channelstack server/,
    );
    await expect(
      launch({ mode: "attach", server: "http://127.0.0.1:9" }, { CHANNELSTACK_TOKEN: "x", CHANNELSTACK_HOME: empty }),
    ).rejects.toThrow(/No channelstack server is answering at http:\/\/127\.0\.0\.1:9/);
  });

  test("start runs a private server, and auto starts one when none is running", async () => {
    const shared = await running();
    const env = { ...process.env, CHANNELSTACK_HOME: shared.home, CHANNELSTACK_SERVER_BIN: BINARY };

    const started = await launch({ mode: "start" }, env);
    cleanups.push(started.stop);
    expect(started.url).not.toBe(shared.url);
    expect(await status(started)).toBe(200);
    // The private server didn't overwrite the shared server's token file.
    expect((await launch({ mode: "attach" }, env)).url).toBe(shared.url);
    await started.stop();
    await expect(status(started)).rejects.toThrow();

    const fresh = await launch(
      { mode: "auto" },
      { ...process.env, CHANNELSTACK_HOME: temporaryHome(), CHANNELSTACK_SERVER_BIN: BINARY },
    );
    cleanups.push(fresh.stop);
    expect(await status(fresh)).toBe(200);
    expect(existsSync(BINARY)).toBe(true);
  });

  test("a binary that can't start is reported, not waited on", async () => {
    await expect(
      launch(
        { mode: "start" },
        { CHANNELSTACK_HOME: temporaryHome(), CHANNELSTACK_SERVER_BIN: "/nonexistent/channelstack" },
      ),
    ).rejects.toThrow(/exited before it was ready/);
  });
});
