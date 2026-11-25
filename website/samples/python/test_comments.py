from channelstack import NotionFixture
from pytest_channelstack import expect


async def test_answers_a_comment_mention_in_the_same_discussion(notion: NotionFixture):
    ana = await notion.create_user(name="Ana")
    # [!step 1]
    page = await notion.create_page(
        title="Roadmap",
        content="# Q1\n- ship search",
        connections=[notion.app],
    )

    # [!step 2]
    comment = await ana.comment("@robin summarize this page", page=page)
    # [!step 3]
    await expect(comment.discussion).to_have_comment_from("robin", text="search")
    # [!step 4]
    await expect(comment.discussion).to_have_comments_from("robin", count=1)
