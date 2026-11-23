import { describe, expect, test } from "vitest";

import { GITHUB_CHECKS, githubChecks, SLACK_CHECKS, slackChecks } from "./index.ts";

describe("skipping a check", () => {
  test("an id no check has is a mistake, and the message lists the ids there are", () => {
    expect(() => githubChecks({ app: "my-agent", skip: ["github.nope"] })).toThrow(
      `No check is called "github.nope". The checks are: ${GITHUB_CHECKS.join(", ")}`,
    );
    expect(() => slackChecks({ app: "my-agent", skip: ["slack.nope", "slack.ack"] })).toThrow(
      `No check is called "slack.nope". The checks are: ${SLACK_CHECKS.join(", ")}`,
    );
  });
});
