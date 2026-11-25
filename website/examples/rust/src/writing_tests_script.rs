// @show:start
use channelstack::{Mode, connect};

#[tokio::main]
async fn main() -> channelstack::Result<()> {
    let client = connect(Mode::Attach).await?;
    let session = client.open_session().send().await?;

    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let msg = ana.say("hi").to(&slack.app()).await?;
    let reply = msg.thread().wait_for_reply().from("my-agent").await?;
    println!("{}", reply.text());

    // Closing the session removes Ana and the DM.
    session.close().await?;
    client.close().await;
    Ok(())
}
// @show:end

#[test]
#[ignore = "needs a running agent"]
fn runs() -> channelstack::Result<()> {
    main()
}
