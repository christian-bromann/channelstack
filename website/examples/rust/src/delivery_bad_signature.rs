use channelstack::{Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn rejects_a_bad_signature_and_a_stale_timestamp() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack.create_user().name("Ana").await?;
    let msg = ana.say("hi").to(&slack.app()).await?;
    let delivery = msg.delivery().expect("the fake delivered the message");

    delivery.resend().bad_signature(true).await?;
    expect(&delivery).to_be_rejected().await?;

    delivery.resend().stale(true).await?;
    expect(&delivery).to_be_rejected().await?;
    // @show:end
    session.close().await
}
