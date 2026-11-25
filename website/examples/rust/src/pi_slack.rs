use channelstack::{Handle, Regex, Result, expect};

use crate::fixtures;

// @show:start
#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_mention_gets_one_reply_in_the_thread() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;

    let msg = ana
        .say("@my-agent summarize the incidents")
        .channel(&channel)
        .await?;

    expect(&msg.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("summarize the incidents")?)
        .await?;
    expect(&msg.thread())
        .to_have_replies_from(&slack.app(), 1)
        .await?;
    expect(&channel)
        .not_to_have_channel_message_from("my-agent")
        .await?;
    session.close().await
}

#[tokio::test]
#[ignore = "needs a running agent"]
async fn it_ignores_other_bots() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let deploy_bot = slack.create_user().name("deploy-bot").bot(true).await?;
    let channel = slack
        .create_channel()
        .participants(vec![&deploy_bot as &dyn Handle, &slack.app()])
        .await?;

    let msg = deploy_bot
        .say("@my-agent build #812 failed")
        .channel(&channel)
        .await?;

    expect(&msg.thread())
        .not_to_have_reply_from("my-agent")
        .await?;
    session.close().await
}
// @show:end
