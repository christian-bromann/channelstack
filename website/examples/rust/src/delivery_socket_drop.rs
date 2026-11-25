use channelstack::{Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn reconnects_after_the_socket_mode_connection_drops() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack.create_user().name("Ana").await?;
    slack.fault().r#type("drop_socket").await?;

    let msg = ana.say("still there?").to(&slack.app()).await?;

    expect(&msg.thread())
        .to_have_reply_from("my-agent")
        .timeout("20s")
        .await?;
    // @show:end
    session.close().await
}
