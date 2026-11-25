use channelstack::{Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn backs_off_on_rate_limits_and_still_answers() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack.create_user().name("Ana").await?;
    let fault = slack
        .fault()
        .r#type("rate_limit")
        .operation("chat.postMessage")
        .retry_after("1s")
        .times(1)
        .await?;

    let msg = ana.say("hi").to(&slack.app()).await?;

    expect(&msg.thread())
        .to_have_replies_from("my-agent", 1)
        .await?;
    expect(&slack)
        .to_have_received_call("chat.postMessage")
        .times(2)
        .await?;
    fault.undo().await?;
    // @show:end
    session.close().await
}
