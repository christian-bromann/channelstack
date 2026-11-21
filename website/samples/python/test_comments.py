from pytest_channelstack import expect


async def test_answers_a_comment_mention_in_the_same_discussion(notion):
    ana = await notion.create_user(name="Ana")
    page = await notion.create_page(  # [!step 1]
        title="Roadmap",  # [!step 1]
        content="# Q1\n- ship search",  # [!step 1]
        connections=[notion.app],  # [!step 1]
    )  # [!step 1]

    comment = await ana.comment("@robin summarize this page", page=page)  # [!step 2]
    await expect(comment.discussion).to_have_comment_from("robin", text="search")  # [!step 3]
    await expect(comment.discussion).to_have_comments_from("robin", count=1)  # [!step 4]
