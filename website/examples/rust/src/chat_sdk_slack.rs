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
async fn follow_ups_in_the_thread_are_answered_without_a_new_mention() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    let msg = ana
        .say("@my-agent what's the status of the web deploy?")
        .channel(&channel)
        .await?;
    expect(&msg.thread()).to_have_reply_from("my-agent").await?;

    ana.reply("and the API?").thread(&msg).await?;

    expect(&msg.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("and the API")?)
        .await?;
    session.close().await
}
// @show:end
