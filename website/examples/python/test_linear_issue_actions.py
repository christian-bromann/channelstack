from channelstack import LinearFixture


async def test_what_people_do_to_an_issue(linear: LinearFixture) -> None:
    ana = await linear.create_user(name="Ana")
    ben = await linear.create_user(name="Ben")
    team = await linear.create_team(members=[ana, ben], labels=["incident"])
    issue = await ana.create_issue({"title": "API latency spike"}, team=team)
    # @show:start
    await ana.set_state("In Progress", issue=issue)
    await ana.assign(ben, issue=issue)
    await ana.label(["incident"], issue=issue)
    await ana.edit_issue({"priority": 1}, issue=issue)

    comment = await ana.comment("Is this still happening?", issue=issue)
    await ana.reply("@my-agent can you check the logs?", comment=comment)
    await ana.edit("Is this still happening on Safari?", comment=comment)
    # @show:end
