import { test } from "vitest";

test("a database a Notion test creates", async ({ notion }) => {
  // @show:start
  const tasks = await notion.createDatabase({
    title: "Tasks",
    properties: { Name: "title", Status: { status: ["Todo", "Ready for agent", "Done"] }, Estimate: "number" },
    rows: [{ Name: "Write the onboarding guide", Status: "Todo" }],
    connections: [notion.app],
  });
  const [row] = await tasks.rows({ Name: "Write the onboarding guide" });
  // @show:end
  void row;
});
