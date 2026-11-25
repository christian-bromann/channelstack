from channelstack import NotionFixture


async def test_a_page_the_integration_isnt_connected_to(notion: NotionFixture) -> None:
    ana = await notion.create_user(name="Ana")
    # @show:start
    notes = await notion.create_page(title="Private notes")  # not connected
    comment = await ana.comment("@my-agent read this", page=notes)
    assert comment.delivery is None

    await ana.connect(notion.app, page=notes)
    # @show:end
