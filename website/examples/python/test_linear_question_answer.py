# @show:start
import re

from channelstack import LinearFixture
from pytest_channelstack import expect


async def test_the_agent_asks_a_question_and_continues_after_the_answer(linear: LinearFixture) -> None:
    ana = await linear.create_user(name="Ana")
    team = await linear.create_team(members=[ana])
    issue = await ana.create_issue({"title": "Fix the login bug"}, team=team)
    session = await ana.delegate(linear.app, issue=issue)

    question = await session.wait_for_activity(type="elicitation")
    await expect(issue).to_have_session_state("awaitingInput")
    await ana.answer("Only Safari 18", elicitation=question)

    await expect(session).to_have_activity(type="response", text=re.compile("safari 18", re.I))
    await expect(linear).to_have_received_call("agentActivityCreate")
    assert await linear.calls(error=True) == []
# @show:end
