from channelstack import NotionFixture


async def test_the_people_a_notion_test_creates(notion: NotionFixture) -> None:
    # @show:start
    ana = await notion.create_user(name="Ana")
    ben = await notion.create_user(name="Ben", email="ben@example.com")
    # @show:end
    _ = (ana, ben)
