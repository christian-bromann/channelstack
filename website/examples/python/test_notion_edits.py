from channelstack import NotionFixture


async def test_editing_a_page(notion: NotionFixture) -> None:
    ana = await notion.create_user(name="Ana")
    page = await notion.create_page(title="Spec", content="# Spec\nTODO: billing", connections=[notion.app])
    # @show:start
    await ana.edit({"append": "## Open questions\n- who owns billing?"}, page=page)
    await ana.edit({"replace": "# Draft\nStarting over."}, page=page)
    await ana.rename("Spec v2", page=page)
    await ana.mention(notion.app, page=page, in_block="TODO")
    # @show:end
