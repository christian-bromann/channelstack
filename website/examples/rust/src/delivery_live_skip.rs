use channelstack::{Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn survives_slacks_retry() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack.create_user().name("Ana").await?;
    let msg = ana.say("@my-agent hello").to(&slack.app()).await?;
    // Rust's test harness can't skip at run time: the test says why and passes.
    let Some(delivery) = msg.delivery() else {
        eprintln!("skipped: live: the platform delivers to the agent itself");
        return Ok(());
    };
    delivery.retry().after("3s").reason("http_timeout").await?;
    expect(&msg.thread())
        .to_have_replies_from(&slack.app(), 1)
        .await?;
    // @show:end
    session.close().await
}
