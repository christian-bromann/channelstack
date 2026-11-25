use channelstack::{Handle, Regex, Result};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_follow_up_in_the_thread() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    // @show:start
    let msg = ana
        .say("@my-agent what's the status of the web deploy?")
        .channel(&channel)
        .await?;
    msg.thread().wait_for_reply().from("my-agent").await?;

    ana.reply("and the API?").thread(&msg).await?;

    let answer = msg.thread().wait_for_reply().from("my-agent").await?;
    assert!(Regex::new("(?i)api")?.is_match(&answer.text()));
    // @show:end
    session.close().await
}
