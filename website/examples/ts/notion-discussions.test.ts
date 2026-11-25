import { test } from "vitest";

test("comments and discussions", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  const page = await notion.createPage({
    title: "API design",
    content: "# Rate limits\n100 requests a minute.",
    connections: [notion.app],
  });
  // @show:start
  const comment = await ana.comment("@my-agent is this enough for the mobile app?", { page, anchor: "Rate limits" });
  await comment.discussion.waitForComment({ from: notion.app });

  await ana.reply("@my-agent and what should we change?", { discussion: comment.discussion });
  await ana.editComment("@my-agent is this enough for the iOS app?", { comment });
  await ana.resolve({ discussion: comment.discussion });
  // @show:end
});
