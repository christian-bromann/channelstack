async def test_stop_ends_a_working_session(linear):
    kai = await linear.create_user(name="Kai")
    team = await linear.create_team(key="ENG", members=[kai])
    issue = await kai.create_issue(title="Migrate billing cron", team=team)  # [!step 1]

    session = await kai.delegate(linear.app, issue=issue)  # [!step 2]
    await expect(session).to_have_activity(type="thought")  # [!step 3]

    await kai.stop(session=session)  # [!step 4]
    await expect(session).to_have_session_state("complete")  # [!step 5]
