import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { systemClock, systemTimers } from "../clock/index.ts";
import { EventLog } from "../events/index.ts";
import { createLogger } from "../log/index.ts";
import { Redactor } from "../redact/index.ts";
import { DeliveryQueue } from "./index.ts";
import { deliveryTo } from "./kit.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections?.() ?? server.close();
});

/** An agent that answers after `delayMs`. */
async function slowAgent(delayMs: number): Promise<{ url: string; received: () => number }> {
  let received = 0;
  const server = createServer((_request, response) => {
    received++;
    setTimeout(() => response.writeHead(200).end("ok"), delayMs);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`, received: () => received };
}

function queue() {
  const redactor = new Redactor();
  const events = new EventLog(systemClock, redactor);
  const delivery = new DeliveryQueue({
    events,
    clock: systemClock,
    timers: systemTimers,
    log: createLogger({ level: "silent", redactor, write: () => {} }),
  });
  const send = (session: string, url: string, timeoutMs = 3000) =>
    delivery.enqueue({
      id: `ED-${session}`,
      session,
      driver: "echo",
      type: "message.created",
      url,
      body: "{}",
      sign: () => ({}),
      timeoutMs,
    });
  return { events, delivery, send };
}

describe("delivery queue", () => {
  test("a session closed while its delivery is in flight stays gone", async () => {
    const agent = await slowAgent(300);
    const { events, delivery, send } = queue();
    send("ses_closing", agent.url);
    send("ses_open", agent.url);
    await expect.poll(agent.received).toBe(2);

    // What closing a session does: cancel its deliveries, then drop its log.
    delivery.cancel("ses_closing");
    events.drop("ses_closing");
    await delivery.settled();

    expect(events.read("ses_closing").events).toEqual([]);
    // Other sessions are untouched.
    expect(events.read("ses_open").events.map((event) => [event.kind, event.data.status])).toEqual([
      ["delivery", undefined],
      ["delivery_attempt", "acknowledged"],
    ]);
  });

  test("an agent that misses the ack window is recorded as timed out", async () => {
    const agent = await slowAgent(500);
    const { events, delivery, send } = queue();
    send("ses_a", agent.url, 50);
    await delivery.settled();
    expect(events.read("ses_a").events[1]?.data).toMatchObject({ status: "timed_out", number: 1 });
  });

  test("a session can deliver again after an earlier one with the same id was cancelled", async () => {
    const agent = await slowAgent(0);
    const { events, delivery, send } = queue();
    delivery.cancel("ses_a");
    send("ses_a", agent.url);
    await delivery.settled();
    expect(events.read("ses_a").events.at(-1)?.data).toMatchObject({ status: "acknowledged" });
  });
});

describe("R1.2: a message's delivery to one app", () => {
  test("the first that went to the app, the built-in one unless another is named", () => {
    const sent = [
      { app: "coder", id: "d1" },
      { app: "my-agent", id: "d2" },
      { app: "coder", id: "d3" },
    ];
    expect(deliveryTo(sent)?.id).toBe("d2");
    expect(deliveryTo(sent, "coder")?.id).toBe("d1");
    expect(deliveryTo(sent, "writer")).toBeUndefined();
    // A record without an app went to the built-in one.
    const records = [{ request: { app: "coder" } }, { request: {} }];
    expect(deliveryTo(records)).toBe(records[1]);
    expect(deliveryTo(records, "coder")).toBe(records[0]);
  });
});
