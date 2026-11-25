from channelstack import GitHubFixture


async def test_reviews_review_comments_and_merging(github: GitHubFixture) -> None:
    ana = await github.create_user(login="ana")
    ben = await github.create_user(login="ben")
    repo = await github.create_repo(files="./fixtures/web", collaborators=[ana, ben], apps=[github.app])
    pr = await ana.open_pull_request(
        {"from": "feat", "draft": True, "changes": {"src/app.ts": "export const x = 1\n"}}, repo=repo
    )
    # @show:start
    await ana.mark_ready(pr=pr)
    await ben.review(
        {
            "pr": pr,
            "event": "REQUEST_CHANGES",
            "body": "@my-agent please address these",
            "comments": [{"path": "src/app.ts", "line": 1, "body": "name this something clearer"}],
        }
    )

    inline = await ana.review_comment("@my-agent why is this exported?", pr=pr, path="src/app.ts", line=1)
    await ana.reply("thanks", comment=inline)
    await ana.resolve(comment=inline)

    await ana.request_review([ben], pr=pr)
    await ana.merge(pr=pr, method="squash")
    # @show:end
