from channelstack import ResendFixture
from pytest_channelstack import expect


async def test_answers_once_even_when_resend_retries(resend: ResendFixture):
    ana = await resend.create_user(name="Ana")
    # [!step 1]
    email = await ana.send(to=[resend.app], subject="Refund",
                           text="Where is my refund for #4411?")

    # [!step 2]
    answer = await email.thread.wait_for_reply(from_="my-agent")
    assert "refund" in answer.text

    # Resend delivers the webhook again, with the same svix-id
    # [!step 3]
    assert email.delivery
    await email.delivery.redeliver()
    # [!step 4]
    await expect(email.thread).to_have_replies_from("my-agent", count=1)
