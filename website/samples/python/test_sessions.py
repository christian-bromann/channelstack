from channelstack import LinearFixture
from pytest_channelstack import expect


async def test_stop_ends_a_working_session(linear: LinearFixture):
    kai = await linear.create_user(name="Kai")
    team = await linear.create_team(key="ENG", members=[kai])
    # [!step 1]
    issue = await kai.create_issue({"title": "Migrate cron"}, team=team)

    # [!step 2]
    session = await kai.delegate(linear.app, issue=issue)
    # [!step 3]
    await expect(session).to_have_activity(type="thought")

    # [!step 4]
    await kai.stop(session=session)
    # [!step 5]
    await expect(session).to_have_session_state("complete")
