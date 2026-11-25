import { test } from "vitest";

test("pages and rows a person creates", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  const space = await notion.createPage({ title: "Engineering", connections: [notion.app] });
  const tasks = await notion.createDatabase({
    title: "Tasks",
    properties: { Name: "title", Status: { status: ["Todo", "Ready for agent", "Done"] } },
    connections: [notion.app],
  });
  // @show:start
  const report = await ana.createPage({ title: "Checkout outage", parent: space, content: "Started 09:12 UTC" });

  const row = await ana.addRow({ Name: "Migrate to Postgres 17", Status: "Todo" }, { database: tasks });
  await ana.setProperty("Status", "Ready for agent", { page: row });
  // @show:end
  void report;
});
