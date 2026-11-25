from channelstack import NotionFixture


async def test_comments_and_discussions(notion: NotionFixture) -> None:
    ana = await notion.create_user(name="Ana")
    page = await notion.create_page(
        title="API design",
        content="# Rate limits\n100 requests a minute.",
        connections=[notion.app],
    )
    # @show:start
    comment = await ana.comment("@my-agent is this enough for the mobile app?", page=page, anchor="Rate limits")
    await comment.discussion.wait_for_comment(from_=notion.app)

    await ana.reply("@my-agent and what should we change?", discussion=comment.discussion)
    await ana.edit_comment("@my-agent is this enough for the iOS app?", comment=comment)
    await ana.resolve(discussion=comment.discussion)
    # @show:end
