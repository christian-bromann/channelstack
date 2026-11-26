from channelstack import GoogleFixture
from pytest_channelstack import expect


async def test_answers_in_anas_thread_in_her_mailbox(google: GoogleFixture):
    ana = await google.create_user(name="Ana")
    # [!step 1]
    email = await ana.send(to=[google.app], subject="Invoice",
                           text="Can you resend the March invoice?")

    # [!step 2]
    answer = await ana.wait_for_email(from_="my-agent")
    # [!step 3]
    assert answer.subject == "Re: Invoice"
    assert answer.thread.id == email.thread.id
    # [!step 4]
    await expect(email.thread).to_have_replies_from(google.app, count=1)
