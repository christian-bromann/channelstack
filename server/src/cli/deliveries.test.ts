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

  test("names the channels when one is missing or unknown", async () => {
    const { server, asked } = recording();
    await expect(runDeliveries(server, undefined)).rejects.toThrow(
      new CliError(`say which channel: ${CHANNELS.join(", ")}.`),
    );
    await expect(runDeliveries(server, "teams")).rejects.toThrow(/, not "teams"\.$/);
    expect(asked).toEqual([]);
  });
});

describe("channelstack redeliver", () => {
  test("Slack retries the way Slack does; the others redeliver", async () => {
    const { server, asked } = recording();
    expect(await runRedeliver(server, "slack", "Ev01")).toBe("Retried Ev01\n");
    for (const channel of ["github", "linear", "notion"]) {
      expect(await runRedeliver(server, channel, "d/1")).toBe("Redelivered d/1\n");
    }
    expect(asked).toEqual([
      "POST /sessions/ses_dev/slack/deliveries/Ev01/retry",
      // The id is one path segment, whatever it holds.
      "POST /sessions/ses_dev/github/deliveries/d%2F1/redeliver",
      "POST /sessions/ses_dev/linear/deliveries/d%2F1/redeliver",
      "POST /sessions/ses_dev/notion/deliveries/d%2F1/redeliver",
    ]);
  });

  test("asks for the delivery when it is missing", async () => {
    const { server } = recording();
    await expect(runRedeliver(server, "github", undefined)).rejects.toThrow(
      "say which delivery: an id that `channelstack deliveries github` printed.",
    );
  });
});
