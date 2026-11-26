//! The home page's Gmail example (website/samples/gmail.test.ts), in Rust.
// @show:start
use channelstack::{Mode, Result, connect, expect};

#[ignore = "needs a running agent"] // @hide
#[tokio::test]
async fn answers_in_anas_thread_in_her_mailbox() -> Result<()> {
    let client = connect(Mode::Auto).await?;
    let test_session = client.open_session().send().await?;
    let google = test_session.google().await?;
    let ana = google.create_user().name("Ana").await?;
    // [!step 1]
    let email = ana
        .send()
        .to(vec![&google.app()])
        .subject("Invoice")
        .text("Can you resend the March invoice?")
        .await?;

    // [!step 2]
    let answer = ana.wait_for_email().from(&google.app()).await?;
    // [!step 3]
    assert_eq!(answer.subject(), "Re: Invoice");
    assert_eq!(answer.thread().id(), email.thread().id());
    // [!step 4]
    expect(&email.thread())
        .to_have_replies_from(&google.app(), 1)
        .await?;

    test_session.close().await
}
// @show:end
