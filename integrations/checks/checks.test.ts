import { describe, expect, type RunnerTask, test } from "vitest";

import {
  GITHUB_CHECKS,
  githubChecks,
  LINEAR_CHECKS,
  linearChecks,
  NOTION_CHECKS,
  notionChecks,
  SLACK_CHECKS,
  slackChecks,
} from "./index.ts";

// Registered and never run: the test below reads which checks each call put in its suite.
describe.skip("registered", () => {
  slackChecks({ app: "my-agent" });
  linearChecks({ app: "my-agent" });
  notionChecks({ app: "my-agent" });
});

/** The ids in the names of the tests under a task. */
const idsUnder = (task: RunnerTask): string[] =>
  "tasks" in task ? task.tasks.flatMap(idsUnder) : [/\[([a-z.-]+)\]$/.exec(task.name)?.[1] ?? ""];

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

describe("what is registered", () => {
  test("a check whose option isn't given is left out; every other check is there, once", ({ task }) => {
    const registered = task.file.tasks.find((entry) => entry.name === "registered");
    if (!registered) throw new Error("The registered checks are missing");
    const ids = idsUnder(registered);
    // `streamPrompt` and `approval` weren't given: the four checks that need them aren't there.
    const needOptions = ["slack.stream-stop", "slack.stop", "slack.click-unauthorized", "slack.double-click"];
    expect(ids).toEqual([
      ...SLACK_CHECKS.filter((id) => !needOptions.includes(id)),
      ...LINEAR_CHECKS,
      ...NOTION_CHECKS,
    ]);
  });
});
