from channelstack import NotionFixture


async def test_pages_and_rows_a_person_creates(notion: NotionFixture) -> None:
    ana = await notion.create_user(name="Ana")
    space = await notion.create_page(title="Engineering", connections=[notion.app])
    tasks = await notion.create_database(
        title="Tasks",
        properties={"Name": "title", "Status": {"status": ["Todo", "Ready for agent", "Done"]}},
        connections=[notion.app],
    )
    # @show:start
    report = await ana.create_page({"title": "Checkout outage", "parent": space, "content": "Started 09:12 UTC"})

    row = await ana.add_row({"Name": "Migrate to Postgres 17", "Status": "Todo"}, database=tasks)
    await ana.set_property("Status", "Ready for agent", page=row)
    # @show:end
    _ = report
