from channelstack import GitHubFixture
from pytest_channelstack import expect


async def test_answers_on_the_issue_and_ignores_itself(
        github: GitHubFixture):
    mo = await github.create_user(login="mo")
    repo = await github.create_repo(collaborators=[mo], apps=[github.app])
    # [!step 1]
    issue = await mo.open_issue({"title": "500s on Safari"}, repo=repo)

    # [!step 2]
    comment = await mo.comment("@my-agent take a look?", issue=issue)
    # [!step 3]
    await expect(issue).to_have_comment_from("my-agent", text="Safari")

    # the same delivery again must not start a second run
    # [!step 4]
    assert comment.delivery
    await comment.delivery.redeliver()
    # [!step 5]
    await expect(issue).to_have_comments_from("my-agent", count=1)
