from channelstack import NotionFixture


async def test_the_pages_a_notion_test_creates(notion: NotionFixture) -> None:
    # @show:start
    space = await notion.create_page(title="Engineering", connections=[notion.app])
    spec = await notion.create_page(
        title="Spec",
        parent=space,
        content={"path": "./fixtures/spec.md"},
        icon="📐",
    )
    # @show:end
    _ = spec
