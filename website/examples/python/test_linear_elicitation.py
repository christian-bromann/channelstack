from channelstack import LinearFixture


async def test_answering_the_agent_and_prompting_it_again(linear: LinearFixture) -> None:
    ana = await linear.create_user(name="Ana")
    team = await linear.create_team(members=[ana])
    issue = await ana.create_issue({"title": "Fix the login bug"}, team=team)
    session = await ana.delegate(linear.app, issue=issue)
    # @show:start
    question = await session.wait_for_activity(type="elicitation")
    await ana.answer("Only Safari 18", elicitation=question)

    await ana.prompt("also update the docs", session=session)
    # @show:end
