import { describe, expect, test } from "vitest";

import type { Timers } from "../../../core/clock/index.ts";
import { LiveCredential } from "../../../core/secrets/index.ts";
import { SlackWebClient } from "./client.ts";

/** Timers that run at once, and remember how long they were asked to wait. */
function instantTimers(waits: number[]): Timers {
  return {
    after(delayMs, run) {
      waits.push(delayMs);
      queueMicrotask(run);
      return () => {};
    },
  };
}

const token = new LiveCredential("app", "xoxb-test-value");

describe("the live Slack client", () => {
  test("a 429 waits for Retry-After and asks again", async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return calls === 1
        ? new Response("", { status: 429, headers: { "retry-after": "2" } })
        : Response.json({ ok: true, user_id: "U1" });
    }) as unknown as typeof globalThis.fetch;
    const client = new SlackWebClient({ base: "https://slack.stub/api", fetch, timers: instantTimers(waits) });
    expect(await client.call("auth.test", token)).toMatchObject({ ok: true, user_id: "U1" });
    expect(waits).toEqual([2000]);
    expect(calls).toBe(2);
  });

  test("still rate-limited after the retries: a refusal named ratelimited", async () => {
    const fetch = (async () =>
      new Response("", { status: 429, headers: { "retry-after": "1" } })) as unknown as typeof globalThis.fetch;
    const client = new SlackWebClient({ base: "https://slack.stub/api", fetch, timers: instantTimers([]) });
    await expect(client.call("auth.test", token)).rejects.toMatchObject({ code: "ratelimited" });
  });

  test("a refusal names the method and Slack's code, never the token or the rest of the answer", async () => {
    const fetch = (async () =>
      Response.json({
        ok: false,
        error: "not_in_channel",
        echo: "xoxb-test-value",
      })) as unknown as typeof globalThis.fetch;
    const client = new SlackWebClient({ base: "https://slack.stub/api", fetch, timers: instantTimers([]) });
    const error = await client.call("chat.postMessage", token, { channel: "C1" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "not_in_channel", message: "Slack refused chat.postMessage: not_in_channel" });
    expect(JSON.stringify(error)).not.toContain("xoxb-test-value");
  });

  test("parameters go form-encoded, objects as JSON text, with the token as a bearer", async () => {
    let sent: RequestInit | undefined;
    const fetch = (async (_url: string, init: RequestInit) => {
      sent = init;
      return Response.json({ ok: true });
    }) as unknown as typeof globalThis.fetch;
    const client = new SlackWebClient({ base: "https://slack.stub/api", fetch, timers: instantTimers([]) });
    await client.call("chat.postMessage", token, {
      channel: "C1",
      blocks: [{ type: "divider" }],
      thread_ts: undefined,
    });
    const headers = new Headers(sent?.headers);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(headers.get("authorization")).toBe("Bearer xoxb-test-value");
    expect(Object.fromEntries(new URLSearchParams(String(sent?.body)))).toEqual({
      channel: "C1",
      blocks: '[{"type":"divider"}]',
    });
  });
});
