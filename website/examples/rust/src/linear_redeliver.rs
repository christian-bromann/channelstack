use channelstack::{Handle, Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn linears_delivery_specifics() -> Result<()> {
    let test_session = fixtures::session().await?;
    let linear = test_session.linear().await?;
    let ana = linear.create_user().name("Ana").await?;
    let team = linear
        .create_team()
        .members(vec![&ana as &dyn Handle])
        .await?;
    let issue = ana
        .create_issue(json!({ "title": "Anything" }))
        .team(&team)
        .await?;
    // @show:start
    let session = ana.delegate(&linear.app()).issue(&issue).await?;

    let delivery = session.delivery().expect("the fake delivered the webhook");
    delivery.redeliver().await?; // same webhook, new timestamp, signed again
    delivery.resend().stale(true).await?;
    expect(&delivery).to_be_rejected().await?;
    // @show:end
    test_session.close().await
}
