use channelstack::{Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_streaming_reply_and_stop() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    // @show:start
    let msg = ana
        .say("write a long report on Q3")
        .to(&slack.app())
        .await?;
    expect(&msg.thread())
        .to_have_streaming_reply_from("my-agent")
        .await?;

    ana.stop().thread(&msg).await?;
    expect(&msg.thread()).to_have_status("stopped").await?;
    // @show:end
    session.close().await
}
