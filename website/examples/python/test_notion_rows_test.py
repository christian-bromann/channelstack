# @show:start
from channelstack import NotionFixture
from pytest_channelstack import expect


async def test_database_rows_the_agent_fills_in_a_property(notion: NotionFixture) -> None:
    ana = await notion.create_user(name="Ana")
    tasks = await notion.create_database(
        title="Tasks",
        properties={"Name": "title", "Status": {"status": ["Todo", "In progress", "Done"]}, "Estimate": "number"},
        connections=[notion.app],
    )

    row = await ana.add_row({"Name": "Migrate to Postgres 17", "Status": "Todo"}, database=tasks)
    comment = await ana.comment("@my-agent estimate this", page=row)

    await expect(comment.discussion).to_have_comments_from(notion.app, count=1)
    # Python has no `expect.any(Number)`: once the agent is quiet, read the property and check its type.
    assert isinstance(await row.property("Estimate"), int | float)
    await expect(notion).to_have_received_call("pages.update")
# @show:end
