from channelstack import LinearFixture
from pytest_channelstack import expect


async def test_the_ways_an_issue_reaches_the_agent(linear: LinearFixture) -> None:
    ana = await linear.create_user(name="Ana")
    team = await linear.create_team(members=[ana])
    issue = await ana.create_issue({"title": "Checkout fails on Safari"}, team=team)
    # @show:start
    session = await ana.delegate(linear.app, issue=issue)

    issue2 = await ana.create_issue({"title": "Bump the Node version", "delegate": linear.app}, team=team)
    session2 = await issue2.session()

    comment = await ana.comment("@my-agent can you take a look?", issue=issue)
    assert comment.session
    await expect(comment.session).to_have_activity(type="response")

    await ana.undelegate(issue=issue)
    # @show:end
    _ = (session, session2)
