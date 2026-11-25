from channelstack import LinearFixture


async def test_an_issue_with_its_fields(linear: LinearFixture) -> None:
    ana = await linear.create_user(name="Ana")
    ben = await linear.create_user(name="Ben", admin=True)
    team = await linear.create_team(
        members=[ana, ben],
        labels=["incident"],
        states=[{"name": "Triage", "type": "triage"}],
    )
    # @show:start
    issue = await ana.create_issue(
        {"title": "API latency spike", "labels": ["incident"], "priority": 2, "state": "Triage", "assignee": ben},
        team=team,
    )
    # @show:end
    _ = issue
