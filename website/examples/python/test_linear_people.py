from channelstack import LinearFixture


async def test_the_people_a_linear_test_creates(linear: LinearFixture) -> None:
    # @show:start
    ana = await linear.create_user(name="Ana")
    ben = await linear.create_user(name="Ben", admin=True)
    # @show:end
    _ = (ana, ben)
