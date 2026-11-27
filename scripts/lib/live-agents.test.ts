import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, expect, test } from "vitest";

import type { Recorder } from "../../server/src/core/proxy/record.ts";
import { asForm, tapped } from "./live-agents.ts";

const stops: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

test("a relayed form arrives as the form the platform sent, and is recorded by its kind", async () => {
  // The agent: what reaches it, and its answer.
  const arrived: Array<{ type: string | undefined; body: string; signature: string | undefined }> = [];
  const agent = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      arrived.push({
        type: request.headers["content-type"],
        body,
        signature: request.headers["x-twilio-signature"] as string | undefined,
      });
      response.writeHead(200, { "content-type": "text/xml" }).end("<Response/>");
    });
  });
  await new Promise<void>((resolve) => agent.listen(0, "127.0.0.1", resolve));
  stops.push(() => new Promise((resolve) => agent.close(resolve)));
  const recorded: Array<{ channel: string; type: string; body: string }> = [];
  const recorder: Recorder = {
    exchange: (_channel, request, send) => send(request),
    webhook: (channel, type, body) => {
      recorded.push({ channel, type, body });
    },
  };
  // As the live run chains them: the relay posts to the form hop, which posts to the tap, which posts to the agent.
  const tap = await tapped(
    "twilio",
    `http://127.0.0.1:${(agent.address() as AddressInfo).port}/webhooks/twilio`,
    recorder,
    stops,
  );
  const relayTarget = await asForm(tap, stops);

  // What smee-client posts: the form's fields as JSON, with JSON's content type and the platform's headers.
  const answer = await fetch(relayTarget, {
    method: "POST",
    headers: { "content-type": "application/json", "x-twilio-signature": "sig=" },
    body: JSON.stringify({ MessageSid: "SM1", Body: "Where is my order?", From: "+14155550101" }),
  });
  expect(answer.status).toBe(200);
  expect(await answer.text()).toBe("<Response/>");
  expect(arrived).toEqual([
    {
      type: "application/x-www-form-urlencoded",
      body: "MessageSid=SM1&Body=Where+is+my+order%3F&From=%2B14155550101",
      signature: "sig=",
    },
  ]);
  expect(recorded.map(({ channel, type }) => ({ channel, type }))).toEqual([{ channel: "twilio", type: "message" }]);
});
