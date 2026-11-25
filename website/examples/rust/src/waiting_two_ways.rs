use channelstack::{Handle, Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn matchers_wait_in_two_ways() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    // @show:start
    let msg = ana
        .say("@my-agent summarize yesterday's incidents")
        .channel(&channel)
        .await?;

    // waits for a reply
    expect(&msg.thread()).to_have_reply_from("my-agent").await?;
    // waits for quiet, then counts
    expect(&msg.thread())
        .to_have_replies_from("my-agent", 1)
        .await?;
    // waits for quiet, then checks
    expect(&channel)
        .not_to_have_channel_message_from("my-agent")
        .await?;
    // @show:end
    session.close().await
}
