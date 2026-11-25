from channelstack import LinearFixture
from pytest_channelstack import expect


async def test_linears_delivery_specifics(linear: LinearFixture) -> None:
    ana = await linear.create_user(name="Ana")
    team = await linear.create_team(members=[ana])
    issue = await ana.create_issue({"title": "Anything"}, team=team)
    # @show:start
    session = await ana.delegate(linear.app, issue=issue)

    assert session.delivery
    await session.delivery.redeliver()  # same webhook, new timestamp, signed again
    await session.delivery.resend(stale=True)
    await expect(session.delivery).to_be_rejected()
    # @show:end
