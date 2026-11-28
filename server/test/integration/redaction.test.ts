import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterAll, expect, test } from "vitest";

import { CHANNEL_NAMES } from "../../../sdks/typescript/client.ts";
import { PREFIXED_TOKENS } from "../prefixed-tokens.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

/**
 * `pnpm test:redaction`: a run with known fake secrets and live-shaped tokens must not leave any
 * of them in the server's logs, its error responses or the event log.
 */

// Live-shaped tokens are built at runtime, so no token-shaped literal is ever committed: one of
// each prefixed token every driver knows, fake or live (echo's are this run's own, by value).
const liveShaped = PREFIXED_TOKENS.filter(([name]) => !name.startsWith("echo")).map(([, format]) => format.generate());
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

test("no fake secret and no live-shaped token reaches logs, errors, the event log or the UI", async () => {
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

  // A Resend person's id is their address: errors that name one must not show it, encoded or not.
  const resend = `/sessions/${sessionId}/resend`;
  note(await control("POST", `${resend}/users`, { name: "Ana", address: email }));
  note(await control("POST", `${resend}/users`, { name: "Ana again", address: email }));
  note(await control("GET", `${resend}/users/${encodeURIComponent(`nobody.${email}`)}/inbox`));

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

  // The UI: a browser that opened a login link sees the page and the event log, both without secrets.
  const link: string = note(await control("POST", "/ui/login-links")).url;
  const opened = await fetch(link, { redirect: "manual" });
  const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const asBrowser = async (path: string) => (await fetch(`${server?.url}${path}`, { headers: { cookie } })).text();
  const ui = [await asBrowser("/"), await asBrowser(`/_channelstack/sessions/${sessionId}/events`)].join("\n");
  expect(ui).toContain("<title>channelstack</title>");
  expect(ui).toContain("delivery_attempt");
  const uiSecrets = [new URL(link).searchParams.get("login") ?? "", cookie.split("=")[1] ?? ""];
  expect(uiSecrets.every((secret) => secret.length >= 20)).toBe(true);

  await server.stop();
  const logs = server.output();

  expect(errors.length).toBeGreaterThanOrEqual(secrets.length * 5 + 2);
  expect(logs).toContain('"message":"request"');
  expect(logs).toContain('"message":"delivery attempt"');
  expect(events).toContain("[redacted]");
  for (const secret of secrets) {
    expect(logs, "logs").not.toContain(secret);
    expect(JSON.stringify(errors), "error responses").not.toContain(secret);
    expect(events, "event log").not.toContain(secret);
    expect(ui, "the UI").not.toContain(secret);
  }
  // The login code and the browser's session never reach the logs. (The start banner prints its own link, once, by design.)
  for (const secret of uiSecrets) expect(logs, "logs").not.toContain(secret);
  // Emails are scrubbed from logs and errors. The event log keeps message content, which is what tests read.
  expect(logs).not.toContain(email);
  expect(logs).not.toContain(encodeURIComponent(email));
  expect(JSON.stringify(errors)).not.toContain(email);
  expect(JSON.stringify(errors)).not.toContain(encodeURIComponent(email));
});

// Exit check 12.5: with two apps per channel, the extra apps' secrets are scrubbed the same way.
// Each is made once per install and handed to the redactor as it is made (decision 0027).
test("with two apps per channel, no extra app's secret reaches logs, errors, the event log or the UI", async () => {
  // An agent that echoes what it was sent, headers and all: what is signed for each app must not show.
  const echoing = createServer((request, response) => {
    response.writeHead(500).end(`upstream said: ${JSON.stringify(request.headers)}`);
  });
  await new Promise<void>((resolve) => echoing.listen(0, "127.0.0.1", resolve));
  const webhook = `http://127.0.0.1:${(echoing.address() as AddressInfo).port}/events`;
  const apps = await startBinary({
    args: ["--no-portless", "--port", "0", "--log-level", "debug"],
    env: { CHANNELSTACK_ECHO_WEBHOOK_URL: webhook, CHANNELSTACK_ECHO_APP_CODER_WEBHOOK_URL: webhook },
  });
  try {
    const { control } = apps;
    const errors: unknown[] = [];
    const note = (response: { status: number; body: unknown }) => {
      if (response.status >= 400) errors.push(response.body);
      return response.body as any;
    };
    const { sessionId } = note(await control("POST", "/sessions"));
    // Two apps beside my-agent on every channel, one made by a test and one by `channelstack env --app`,
    // and each app's lines printed, as its agent's `.env` would have them.
    for (const channel of ["echo", ...CHANNEL_NAMES]) {
      note(await control("POST", `/sessions/${sessionId}/${channel}/apps`, { name: "coder" }));
      for (const app of ["coder", "reviewer"]) note(await control("GET", `/env?app=${app}&channel=${channel}`));
    }
    const stored = JSON.parse(readFileSync(join(apps.home, "secrets.json"), "utf8")).apps as Record<
      string,
      Record<string, Record<string, string>>
    >;
    const secrets = Object.values(stored).flatMap((byApp) => Object.values(byApp).flatMap(Object.values));
    expect(Object.keys(stored).sort()).toEqual(["echo", ...CHANNEL_NAMES].sort());
    for (const byApp of Object.values(stored)) expect(Object.keys(byApp).sort()).toEqual(["coder", "reviewer"]);

    // Both echo apps hear Ana in a room, each signed with its own secret, at an agent that echoes it all.
    const base = `/sessions/${sessionId}/echo`;
    const fixture = note(await control("GET", base));
    const coder = note(await control("POST", `${base}/apps`, { name: "coder" }));
    const ana = note(await control("POST", `${base}/users`, { name: "Ana" }));
    const room = note(await control("POST", `${base}/rooms`, { participants: [ana.id, fixture.app.id, coder.id] }));

    // The same paths as above: content, ids, bodies that fail validation, and headers on every channel's API.
    for (const secret of secrets) {
      note(await control("POST", `${base}/users/${ana.id}/say`, { text: `a secret: ${secret}`, room: room.id }));
      if (/^[\w.-]+$/.test(secret)) {
        note(await control("GET", `${base}/rooms/${secret}/messages`));
        note(await control("GET", `/sessions/${secret}/events`));
      }
      note(await control("POST", `${base}/users/${ana.id}/say`, { text: "x", room: secret }));
      note(await control("POST", `${base}/apps`, { name: secret }));
      // A header holds one line: a private key goes in the body only.
      const header = secret.includes("\n") ? "multi-line" : secret;
      note(await control("GET", "/status", undefined, header));
      for (const channel of ["echo", ...CHANNEL_NAMES]) {
        await fetch(`${apps.url}/${channel}/api/nothing-here`, {
          method: "POST",
          headers: { authorization: `Bearer ${header}`, "content-type": "application/json" },
          body: JSON.stringify({ text: secret }),
        });
      }
    }

    // Let every delivery's first attempt finish, so what the agent answered is in the log too.
    await expect
      .poll(
        async () => {
          const { events: logged } = (await control("GET", `/sessions/${sessionId}/events`)).body as {
            events: Array<{ kind: string; data: { app?: string } }>;
          };
          const sent = logged.filter((event) => event.kind === "delivery");
          const tried = logged.filter((event) => event.kind === "delivery_attempt");
          return tried.length >= sent.length ? new Set(sent.map((event) => event.data.app)) : 0;
        },
        { timeout: 20_000 },
      )
      .toEqual(new Set(["my-agent", "coder"]));
    const events = JSON.stringify((await control("GET", `/sessions/${sessionId}/events`)).body);

    const link: string = note(await control("POST", "/ui/login-links")).url;
    const opened = await fetch(link, { redirect: "manual" });
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const asBrowser = async (path: string) => (await fetch(`${apps.url}${path}`, { headers: { cookie } })).text();
    const ui = [await asBrowser("/"), await asBrowser(`/_channelstack/sessions/${sessionId}/events`)].join("\n");
    expect(ui).toContain("delivery_attempt");

    await apps.stop();
    const logs = apps.output();
    expect(secrets.length).toBeGreaterThanOrEqual(2 * (CHANNEL_NAMES.length + 1));
    expect(errors.length).toBeGreaterThan(secrets.length * 3);
    expect(logs).toContain('"message":"delivery attempt"');
    expect(events).toContain("[redacted]");
    for (const secret of secrets) {
      expect(logs, "logs").not.toContain(secret);
      expect(JSON.stringify(errors), "error responses").not.toContain(secret);
      expect(events, "event log").not.toContain(secret);
      expect(ui, "the UI").not.toContain(secret);
    }
  } finally {
    await apps.stop();
    echoing.close();
  }
}, 60_000);
