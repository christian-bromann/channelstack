import { test } from "vitest";

test("the channels a Slack test creates", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const ben = await slack.createUser({ name: "Ben", admin: true });
  // @show:start
  const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
  const incidents = await slack.createChannel({ name: "incidents", private: true, participants: [ana, slack.app] });
  // @show:end
  void [channel, incidents];
});
