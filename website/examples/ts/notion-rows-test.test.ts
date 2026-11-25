// @show:start
import { expect, test } from "vitest";

test("database rows: the agent fills in a property", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  const tasks = await notion.createDatabase({
    title: "Tasks",
    properties: { Name: "title", Status: { status: ["Todo", "In progress", "Done"] }, Estimate: "number" },
    connections: [notion.app],
  });

  const row = await ana.addRow({ Name: "Migrate to Postgres 17", Status: "Todo" }, { database: tasks });
  const comment = await ana.comment("@my-agent estimate this", { page: row });

  await expect(row).toHavePropertyValue("Estimate", expect.any(Number));
  await expect(comment.discussion).toHaveCommentsFrom(notion.app, { count: 1 });
  await expect(notion).toHaveReceivedCall("pages.update");
});
// @show:end
