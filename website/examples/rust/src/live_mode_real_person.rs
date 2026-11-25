use channelstack::{Handle, Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_real_person_asks_the_real_agent() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;

    let msg = ana
        .say("@my-agent summarize #support today")
        .channel(&channel)
        .await?;

    expect(&msg.thread())
        .to_have_reply_from("my-agent")
        .timeout("30s")
        .await?;
    // @show:end
    session.close().await
}
