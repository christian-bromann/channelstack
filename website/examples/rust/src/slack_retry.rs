use channelstack::{Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn slacks_retry_is_answered_once() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let msg = ana.say("@my-agent hi").to(&slack.app()).await?;
    // @show:start
    let delivery = msg.delivery().expect("the fake delivered the message");
    delivery
        .retry()
        .after("3s")
        .reason("http_timeout")
        .await?;
    expect(&msg.thread())
        .to_have_replies_from("my-agent", 1)
        .await?;
    // @show:end
    session.close().await
}
