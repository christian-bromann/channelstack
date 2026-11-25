# @show:start
import re

from channelstack import NotionFixture
from pytest_channelstack import expect


async def test_a_mention_in_a_page_comment_gets_a_reply_in_the_same_discussion(notion: NotionFixture) -> None:
    ana = await notion.create_user(name="Ana")
    page = await notion.create_page(
        title="Roadmap",
        content="# Q1\n- ship search\n- ship billing",
        connections=[notion.app],
    )

    comment = await ana.comment("@my-agent summarize this page", page=page)

    await expect(comment.discussion).to_have_comment_from("my-agent", text=re.compile("search", re.I))
    await expect(comment.discussion).to_have_comments_from(notion.app, count=1)
# @show:end
