use channelstack::{Handle, Regex, Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_mention_gets_exactly_one_reply_in_the_thread() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;

    let msg = ana
        .say("@my-agent summarize yesterday's incidents")
        .channel(&channel)
        .await?;

    expect(&msg.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("(?i)incident")?)
        .await?;
    expect(&msg.thread())
        .to_have_replies_from(&slack.app(), 1)
        .await?;
    expect(&channel)
        .not_to_have_channel_message_from("my-agent")
        .await?;
    // @show:end
    session.close().await
}
