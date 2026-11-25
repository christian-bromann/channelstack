from channelstack import NotionFixture


async def test_a_database_a_notion_test_creates(notion: NotionFixture) -> None:
    # @show:start
    tasks = await notion.create_database(
        title="Tasks",
        properties={"Name": "title", "Status": {"status": ["Todo", "Ready for agent", "Done"]}, "Estimate": "number"},
        rows=[{"Name": "Write the onboarding guide", "Status": "Todo"}],
        connections=[notion.app],
    )
    [row] = await tasks.rows({"Name": "Write the onboarding guide"})
    # @show:end
    _ = row
