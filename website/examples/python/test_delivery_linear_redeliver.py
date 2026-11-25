from channelstack import LinearFixture
from pytest_channelstack import expect


# @show:start
async def test_a_redelivered_webhook_doesnt_duplicate_activities(linear: LinearFixture) -> None:
    ana = await linear.create_user(name="Ana")
    team = await linear.create_team(members=[ana])
    issue = await ana.create_issue({"title": "Anything"}, team=team)
    session = await ana.delegate(linear.app, issue=issue)
    await expect(session).to_have_activity(type="thought")
    before = len(await session.activities())

    assert session.delivery
    await session.delivery.redeliver()

    await expect(issue).to_have_session_state("complete")
    thoughts = [a for a in await session.activities() if a.type == "thought"]
    assert len(thoughts) <= before
# @show:end
