# @show:start
from channelstack import LinearFixture
from pytest_channelstack import expect


async def test_delegating_an_issue_opens_one_session_with_a_first_thought(linear: LinearFixture) -> None:
    ana = await linear.create_user(name="Ana")
    team = await linear.create_team(members=[ana])
    issue = await ana.create_issue({"title": "Checkout fails on Safari"}, team=team)

    session = await ana.delegate(linear.app, issue=issue)

    await expect(session).to_have_activity(type="thought", timeout="10s")
    await expect(issue).to_be_delegated_to(linear.app)
    assert len(await issue.sessions()) == 1
# @show:end
