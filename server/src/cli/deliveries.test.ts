import { describe, expect, test } from "vitest";

import { type Attached, CliError } from "./attach.ts";
import { CHANNELS, runDeliveries, runRedeliver } from "./deliveries.ts";

/** An attachment that records what the commands ask the control API, and answers from `answers`. */
function recording(answers: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const server: Attached = {
    url: "http://127.0.0.1:1",
    devSession: async () => "ses_dev",
    request: async <T>(method: string, path: string) => {
      asked.push(`${method} ${path}`);
      return answers[`${method} ${path}`] as T;
    },
  };
  return { server, asked };
}

const attempt = (responseStatus: number) => ({ responseStatus });

describe("channelstack deliveries", () => {
  test("lists each channel's deliveries with what they were and how they ended", async () => {
    const { server } = recording({
      "GET /sessions/ses_dev/slack/deliveries": [
        {
          id: "Ev01",
          type: "event_callback",
          eventType: "app_mention",
          status: "acknowledged",
          attempts: [attempt(200)],
        },
      ],
      "GET /sessions/ses_dev/github/deliveries": [
        {
          id: "3f2a",
          type: "issue_comment",
          action: "created",
          status: "failed",
          attempts: [attempt(500), attempt(200)],
        },
      ],
      "GET /sessions/ses_dev/linear/deliveries": [
        { id: "9c1d", type: "AgentSessionEvent", action: "created", status: "acknowledged", attempts: [{}] },
      ],
      "GET /sessions/ses_dev/notion/deliveries": [],
    });
    expect(await runDeliveries(server, "slack")).toBe(
      "Ev01  event_callback app_mention  acknowledged  (attempts: 200)\n",
    );
    expect(await runDeliveries(server, "github")).toBe("3f2a  issue_comment created  failed  (attempts: 500, 200)\n");
    // An attempt with no answer yet shows as "-".
    expect(await runDeliveries(server, "linear")).toBe(
      "9c1d  AgentSessionEvent created  acknowledged  (attempts: -)\n",
    );
    expect(await runDeliveries(server, "notion")).toBe("Nothing was delivered to the agent on notion yet.\n");
  });

  test("without a channel, every channel's, oldest first, each line with its channel", async () => {
    const { server } = recording({
      "GET /sessions/ses_dev/slack/deliveries": [
        { id: "Ev02", type: "event_callback", eventType: "message", status: "acknowledged", attempts: [sent("10:02")] },
      ],
      "GET /sessions/ses_dev/github/deliveries": [
        { id: "3f2a", type: "issues", action: "opened", status: "acknowledged", attempts: [sent("10:01")] },
      ],
      "GET /sessions/ses_dev/linear/deliveries": [],
      "GET /sessions/ses_dev/notion/deliveries": [],
    });
    expect(await runDeliveries(server, undefined)).toBe(
      "github 3f2a  issues opened  acknowledged  (attempts: 200)\nslack  Ev02  event_callback message  acknowledged  (attempts: 200)\n",
    );
    const { server: empty } = recording(
      Object.fromEntries(CHANNELS.map((c) => [`GET /sessions/ses_dev/${c}/deliveries`, []])),
    );
    expect(await runDeliveries(empty, undefined)).toBe("Nothing was delivered to the agent yet.\n");
  });

  test("an unknown channel is named", async () => {
    const { server, asked } = recording();
    await expect(runDeliveries(server, "teams")).rejects.toThrow(
      new CliError(`say which channel: ${CHANNELS.join(", ")}, not "teams".`),
    );
    expect(asked).toEqual([]);
  });
});

const sent = (at: string) => ({ responseStatus: 200, sentAt: `2026-11-24T${at}:00.000Z` });
const lists = {
  "GET /sessions/ses_dev/slack/deliveries": [
    { id: "Ev01", type: "event_callback", status: "acknowledged", attempts: [sent("10:00")] },
  ],
  "GET /sessions/ses_dev/github/deliveries": [
    { id: "d/1", type: "issues", status: "acknowledged", attempts: [sent("10:03")] },
  ],
  "GET /sessions/ses_dev/linear/deliveries": [
    { id: "9c1d", type: "Issue", status: "acknowledged", attempts: [sent("10:01")] },
  ],
  "GET /sessions/ses_dev/notion/deliveries": [
    { id: "n1", type: "comment.created", status: "acknowledged", attempts: [sent("10:02")] },
  ],
};
const posts = (asked: string[]) => asked.filter((request) => request.startsWith("POST"));

describe("channelstack redeliver", () => {
  test("last is the newest delivery of any channel; Slack retries, the others redeliver", async () => {
    const { server, asked } = recording(lists);
    expect(await runRedeliver(server, [])).toBe("Redelivered d/1 (github)\n");
    expect(await runRedeliver(server, ["last"])).toBe("Redelivered d/1 (github)\n");
    expect(await runRedeliver(server, ["slack"])).toBe("Retried Ev01 (slack)\n");
    expect(await runRedeliver(server, ["notion", "last"])).toBe("Redelivered n1 (notion)\n");
    expect(posts(asked)).toEqual([
      // The id is one path segment, whatever it holds.
      "POST /sessions/ses_dev/github/deliveries/d%2F1/redeliver",
      "POST /sessions/ses_dev/github/deliveries/d%2F1/redeliver",
      "POST /sessions/ses_dev/slack/deliveries/Ev01/retry",
      "POST /sessions/ses_dev/notion/deliveries/n1/redeliver",
    ]);
  });

  test("an id is found in whichever channel has it", async () => {
    const { server, asked } = recording(lists);
    expect(await runRedeliver(server, ["9c1d"])).toBe("Redelivered 9c1d (linear)\n");
    expect(await runRedeliver(server, ["slack", "Ev01"])).toBe("Retried Ev01 (slack)\n");
    expect(posts(asked)).toEqual([
      "POST /sessions/ses_dev/linear/deliveries/9c1d/redeliver",
      "POST /sessions/ses_dev/slack/deliveries/Ev01/retry",
    ]);
  });

  test("says when there is nothing to redeliver, or no such delivery", async () => {
    const { server, asked } = recording(lists);
    await expect(runRedeliver(server, ["nope"])).rejects.toThrow(
      "no delivery nope. `channelstack deliveries` lists them.",
    );
    await expect(runRedeliver(server, ["slack", "9c1d"])).rejects.toThrow("no delivery 9c1d on slack.");
    await expect(runRedeliver(server, ["teams", "x"])).rejects.toThrow(
      'say which channel: slack, github, linear, notion, not "teams".',
    );
    const { server: empty } = recording({ "GET /sessions/ses_dev/slack/deliveries": [] });
    await expect(runRedeliver(empty, ["slack"])).rejects.toThrow("nothing was delivered to the agent on slack yet.");
    expect(posts(asked)).toEqual([]);
  });
});
