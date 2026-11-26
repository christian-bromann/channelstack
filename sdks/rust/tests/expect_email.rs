//! The reply matchers on an email thread (Resend, Gmail), against a server the SDK starts
//! (`Mode::Start`, with `CHANNELSTACK_SERVER_BIN`). No agent runs: two people email each other, so
//! every check is about what they said. `pnpm test:rust` sets the binary; without it, the test says
//! so and passes.

use channelstack::{Error, Handle, Mode, Regex, connect, expect};

#[tokio::test]
async fn reply_matchers_read_an_email_thread() -> channelstack::Result<()> {
    if std::env::var("CHANNELSTACK_SERVER_BIN").is_err() {
        eprintln!("skipped: set CHANNELSTACK_SERVER_BIN (pnpm test:rust does)");
        return Ok(());
    }
    let client = connect(Mode::Start).await?;
    let session = client
        .open_session()
        .name("rust-expect-email")
        .send()
        .await?;

    let resend = session.resend().await?;
    let ana = resend.create_user().name("Ana").await?;
    let ben = resend.create_user().name("Ben").await?;
    let email = ana
        .send()
        .to(vec![&ben as &dyn Handle])
        .subject("Lunch?")
        .text("Noon?")
        .await?;
    ben.reply(&email).text("Noon works").await?;
    let thread = email.thread();
    expect(&thread)
        .to_have_reply_from(&ben)
        .text(Regex::new("(?i)noon works")?)
        .await?;
    expect(&thread).to_have_replies_from(&ben, 1).await?;
    expect(&thread)
        .not_to_have_reply_from(&resend.app())
        .await?;
    match expect(&thread).to_have_replies_from(&ben, 2).await {
        Err(Error::Expectation(message)) => assert!(message.contains("found 1"), "{message}"),
        other => panic!("expected a failed check, got {other:?}"),
    }

    let google = session.google().await?;
    let cy = google.create_user().name("Cy").await?;
    let di = google.create_user().name("Di").await?;
    let email = cy
        .send()
        .to(vec![&di as &dyn Handle])
        .subject("Invoice")
        .text("Sent?")
        .await?;
    di.reply(&email).text("Sent this morning").await?;
    expect(&email.thread())
        .to_have_reply_from(&di)
        .text("Sent this morning")
        .await?;
    expect(&email.thread()).to_have_replies_from(&di, 1).await?;

    session.close().await?;
    client.close().await;
    Ok(())
}
