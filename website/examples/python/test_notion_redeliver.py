from channelstack import NotionFixture
from pytest_channelstack import expect


async def test_notions_deliveries_redelivered_and_forged(notion: NotionFixture) -> None:
    ana = await notion.create_user(name="Ana")
    page = await notion.create_page(title="Roadmap", connections=[notion.app])
    # @show:start
    comment = await ana.comment("@my-agent hi", page=page)
    assert comment.delivery

    await comment.delivery.redeliver()  # the next attempt_number, signed again
    await comment.delivery.resend(bad_signature=True)  # signed with the wrong token
    await expect(comment.delivery).to_be_rejected()
    # @show:end
