/**
 * Where a delivery's message is (exit check 13.5): what a model call's `request.context` names.
 * Read from real deliveries of the fakes, so the paths each driver names are the ones its payloads have.
 */
import { afterEach, describe, expect, test } from "vitest";

import { githubWorkspace } from "../../../test/github-workspace.ts";
import { linearWorkspace } from "../../../test/linear-workspace.ts";
import { slackWorkspace } from "../../../test/slack-workspace.ts";
import { githubPlace } from "../../drivers/github/place.ts";
import { linearPlace } from "../../drivers/linear/place.ts";
import { slackPlace } from "../../drivers/slack/place.ts";
import { placeFrom } from "./place.ts";

const closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

describe("placeFrom", () => {
  test("the first of each id's paths the body has; numbers as text; a form's JSON payload", () => {
    const paths = { from: ["a.id", "b.id"], conversation: ["c"], thread: [], message: ["m"] };
    expect(placeFrom(JSON.stringify({ b: { id: 7 }, c: "C1" }), paths)).toEqual({ from: "7", conversation: "C1" });
    expect(placeFrom(`payload=${encodeURIComponent(JSON.stringify({ a: { id: "U1" } }))}`, paths)).toEqual({
      from: "U1",
    });
    expect(placeFrom("not json", paths)).toBeUndefined();
  });
});

describe("each channel's deliveries", () => {
  test("Slack: the person, the channel, the thread and the message", async () => {
    const workspace = await slackWorkspace();
    closing.push(async () => workspace.agent.close());
    const message = await workspace.say("hello there everyone");
    await workspace.h.app.settled();
    const delivery = workspace.agent.received.at(-1);

    expect(slackPlace(delivery?.body ?? "")).toEqual({
      from: workspace.ana.id,
      conversation: workspace.channel.id,
      thread: message.ts,
      message: message.ts,
    });
  });

  test("GitHub: the sender, the repository and the issue", async () => {
    const workspace = await githubWorkspace();
    closing.push(async () => workspace.agent.close());
    const issue = await workspace.post(`/users/${workspace.ana.id}/issues`, {
      issue: { title: "The deploy fails" },
      repo: workspace.repo.id,
    });
    await workspace.h.app.settled();
    const delivery = workspace.agent.received.find((received) => received.body.includes('"opened"'));

    expect(githubPlace(delivery?.body ?? "")).toEqual(
      expect.objectContaining({
        from: String(workspace.ana.id),
        conversation: String(workspace.repo.id),
        thread: String(issue.number),
      }),
    );
  });

  test("Linear: who wrote the comment, the team and the issue", async () => {
    const workspace = await linearWorkspace();
    closing.push(async () => workspace.agent.close());
    const issue = await workspace.post(`/users/${workspace.ana.id}/issues`, {
      issue: { title: "The deploy fails" },
      team: workspace.team.id,
    });
    await workspace.post(`/users/${workspace.ana.id}/comment`, { body: "and the API?", issue: issue.id });
    await workspace.h.app.settled();
    const delivery = workspace.agent.received.find((received) => received.body.includes('"Comment"'));

    expect(linearPlace(delivery?.body ?? "")).toEqual(
      expect.objectContaining({ from: workspace.ana.id, conversation: workspace.team.id, thread: issue.id }),
    );
  });
});
