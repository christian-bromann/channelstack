# @show:start
import re

from channelstack import GitHubFixture
from pytest_channelstack import expect


async def test_a_mention_in_an_issue_gets_one_comment(github: GitHubFixture) -> None:
    ana = await github.create_user(login="ana")
    repo = await github.create_repo(collaborators=[ana], apps=[github.app])
    issue = await ana.open_issue({"title": "Login fails on Safari"}, repo=repo)

    await ana.comment("@my-agent can you triage this?", issue=issue)

    await expect(issue).to_have_comment_from(github.app, text=re.compile("triage", re.I))
    await expect(issue).to_have_comments_from(github.app, count=1, quiet_for="2s")
# @show:end
