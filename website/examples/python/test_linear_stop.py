from channelstack import LinearFixture
from pytest_channelstack import expect


async def test_stop_ends_the_session(linear: LinearFixture) -> None:
    ana = await linear.create_user(name="Ana")
    team = await linear.create_team(members=[ana])
    issue = await ana.create_issue({"title": "Checkout fails on Safari"}, team=team)
    session = await ana.delegate(linear.app, issue=issue)
    # @show:start
    await expect(session).to_have_activity(type="thought")
    await ana.stop(session=session)
    await expect(session).to_have_session_state("complete")
    # @show:end
