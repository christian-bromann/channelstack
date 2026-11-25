from channelstack import SlackFixture


async def test_slacks_delivery_specifics(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("hi", to=slack.app)
    # @show:start
    await slack.uninstall_app()  # app_uninstalled and tokens_revoked
    await slack.fault(type="rate_limit", operation="chat.postMessage", retry_after="1s", times=1)
    assert msg.delivery
    await msg.delivery.retry(after="3s", reason="http_timeout")
    # @show:end
