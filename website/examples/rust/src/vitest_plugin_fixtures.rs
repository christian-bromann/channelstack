use channelstack::{Handle, Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn answers_in_the_thread() -> Result<()> {
    // @show:start
    // Rust has no fixtures: the test opens its own session (see the SDKs page).
    let session = fixtures::session().await?;
    let slack = session.slack().await?;

    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    let msg = ana.say("@my-agent hi").channel(&channel).await?;
    expect(&msg.thread()).to_have_reply_from("my-agent").await?;
    // latest_reply waits until the agent is quiet.
    msg.thread().latest_reply().from("my-agent").await?;
    // @show:end
    session.close().await
}
