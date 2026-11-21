from pytest_channelstack import expect


async def test_answers_on_the_issue_and_ignores_itself(github):
    mo = await github.create_user(login="mo")
    repo = await github.create_repo(collaborators=[mo], apps=[github.app])
    issue = await mo.open_issue(title="Login 500s on Safari", repo=repo)  # [!step 1]

    comment = await mo.comment("@robin can you take a look?", issue=issue)  # [!step 2]
    await expect(issue).to_have_comment_from("robin", text="Safari")  # [!step 3]

    # the same delivery again must not start a second run
    await comment.delivery.redeliver()  # [!step 4]
    await expect(issue).to_have_comments_from("robin", count=1)  # [!step 5]
