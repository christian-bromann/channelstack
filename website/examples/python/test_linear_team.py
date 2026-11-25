from channelstack import LinearFixture


async def test_a_team_with_its_labels_and_workflow_states(linear: LinearFixture) -> None:
    ana = await linear.create_user(name="Ana")
    ben = await linear.create_user(name="Ben", admin=True)
    # @show:start
    team = await linear.create_team(
        key="OPS",
        members=[ana, ben],
        labels=["incident"],
        states=[
            {"name": "Triage", "type": "triage"},
            {"name": "Investigating", "type": "started"},
            {"name": "Resolved", "type": "completed"},
        ],
    )
    # @show:end
    _ = team
