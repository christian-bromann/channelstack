import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { SECRET_FORMATS } from "../../src/core/secrets/index.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

/**
 * `pnpm test:redaction`: a run with known fake secrets and live-shaped tokens must not leave any
 * of them in the server's logs, its error responses or the event log.
 */

// Live-shaped tokens are built at runtime, so no token-shaped literal is ever committed.
const liveShaped = [
  SECRET_FORMATS["slack.botToken"].generate(),
  SECRET_FORMATS["slack.userToken"].generate(),
  SECRET_FORMATS["github.installationToken"].generate(),
  SECRET_FORMATS["linear.apiKey"].generate(),
  SECRET_FORMATS["notion.token"].generate(),
  ["github", "pat", "11ABCDEFG0aBcDeFgHiJkL", "mNoPqRsTuVwXyZ0123456789"].join("_"),
];
const email = ["ana.live", "example.com"].join("@");

const agent = createServer((_request, response) => {
  // An agent that leaks a token in its response body: the attempt is recorded, the token must not be.
  response.writeHead(500).end(`upstream said: invalid token ${liveShaped[0]}`);
});
let server: RunningBinary | undefined;
afterAll(async () => {
  await server?.stop();
  agent.close();
});

test("no fake secret and no live-shaped token reaches logs, errors or the event log", async () => {
  await new Promise<void>((resolve) => agent.listen(0, "127.0.0.1", resolve));
  const webhook = `http://127.0.0.1:${(agent.address() as AddressInfo).port}/events`;
  server = await startBinary({
    args: ["--no-portless", "--port", "0", "--log-level", "debug"],
    env: { CHANNELSTACK_ECHO_WEBHOOK_URL: webhook },
  });
  const { control } = server;

  const fake = Object.values(
    JSON.parse(readFileSync(join(server.home, "secrets.json"), "utf8")).secrets.echo as Record<string, string>,
  );
  const secrets = [server.token, ...fake, ...liveShaped];
  expect(fake).toHaveLength(2);

  const errors: unknown[] = [];
  const note = (response: { status: number; body: unknown }) => {
    if (response.status >= 400) errors.push(response.body);
    return response.body as any;
  };

  const { sessionId } = note(await control("POST", "/sessions"));
  const base = `/sessions/${sessionId}/echo`;
  const fixture = note(await control("GET", base));
  const ana = note(await control("POST", `${base}/users`, { name: `Ana <${email}>` }));
  const room = note(await control("POST", `${base}/rooms`, { participants: [ana.id, fixture.app.id] }));

  // Secrets in content, in ids, in bodies that fail validation, and in headers.
  for (const secret of secrets) {
    note(
      await control("POST", `${base}/users/${ana.id}/say`, {
        text: `here is a secret: ${secret} (${email})`,
        room: room.id,
      }),
    );
    note(await control("GET", `${base}/rooms/${secret}/messages`));
    note(await control("POST", `${base}/users/${secret}/say`, { text: "x", room: secret }));
    note(await control("POST", `${base}/rooms`, { participants: [secret] }));
    note(await control("GET", `/sessions/${secret}/events`));
    note(await control("GET", `/sessions/${sessionId}/events?since=${secret}`));
    note(await control("GET", "/status", undefined, secret === server.token ? `${secret}x` : secret));
    await fetch(`${server.url}/echo/api/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ room: room.id, text: `agent echoes ${secret}` }),
    });
  }

  // Let every delivery attempt finish, so its outcome is in the log too.
  await expect
    .poll(
      async () =>
        (await control("GET", `/sessions/${sessionId}/events`)).body.events.filter(
          (e: any) => e.kind === "delivery_attempt",
        ).length,
      { timeout: 10_000 },
    )
    .toBe(secrets.length);
  const events = JSON.stringify((await control("GET", `/sessions/${sessionId}/events`)).body);
  await server.stop();
  const logs = server.output();

  expect(errors.length).toBeGreaterThanOrEqual(secrets.length * 5);
  expect(logs).toContain('"message":"request"');
  expect(logs).toContain('"message":"delivery attempt"');
  expect(events).toContain("[redacted]");
  for (const secret of secrets) {
    expect(logs, "logs").not.toContain(secret);
    expect(JSON.stringify(errors), "error responses").not.toContain(secret);
    expect(events, "event log").not.toContain(secret);
  }
  // Emails are scrubbed from logs and errors. The event log keeps message content, which is what tests read.
  expect(logs).not.toContain(email);
  expect(JSON.stringify(errors)).not.toContain(email);
});
