//! The home page's Resend example (website/samples/resend.test.ts), in Rust.
// @show:start
use channelstack::{Mode, Regex, Result, connect, expect};

#[ignore = "needs a running agent"] // @hide
#[tokio::test]
async fn answers_an_email_once_even_when_resend_retries() -> Result<()> {
    let client = connect(Mode::Auto).await?;
    let test_session = client.open_session().send().await?;
    let resend = test_session.resend().await?;
    let ana = resend.create_user().name("Ana").await?;
    // [!step 1]
    let email = ana
        .send()
        .to(vec![&resend.app()])
        .subject("Refund")
        .text("Where is my refund for #4411?")
        .await?;

    // [!step 2]
    expect(&email.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("(?i)refund")?)
        .await?;

    // Resend delivers the webhook again, with the same svix-id
    // [!step 3]
    email.delivery().expect("a delivery").redeliver().await?;
    // [!step 4]
    expect(&email.thread())
        .to_have_replies_from(&resend.app(), 1)
        .await?;

    test_session.close().await
}
// @show:end
