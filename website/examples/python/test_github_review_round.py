# @show:start
from channelstack import GitHubFixture
from pytest_channelstack import expect


async def test_a_full_review_round_changes_requested_fixed_approved_merged(github: GitHubFixture) -> None:
    ana = await github.create_user(login="ana")
    ben = await github.create_user(login="ben")
    repo = await github.create_repo(files="./fixtures/web", collaborators=[ana, ben], apps=[github.app])
    pr = await ana.open_pull_request(
        {"from": "feat", "draft": True, "changes": {"src/app.ts": "export const x = 1\n"}}, repo=repo
    )

    await ana.mark_ready(pr=pr)
    await ben.review(
        {
            "pr": pr,
            "event": "REQUEST_CHANGES",
            "body": "@my-agent please address these",
            "comments": [{"path": "src/app.ts", "line": 1, "body": "name this something clearer"}],
        }
    )

    fix = await pr.head_commit()
    assert fix.author is not None and fix.author.name == github.app.name
    await ben.review({"pr": pr, "event": "APPROVE"})
    await ana.merge(pr=pr, method="squash")
    await expect(pr).to_be_merged()
# @show:end
