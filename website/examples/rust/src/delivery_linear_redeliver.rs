use channelstack::{Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_redelivered_webhook_doesnt_duplicate_activities() -> Result<()> {
    let test_session = fixtures::session().await?;
    let linear = test_session.linear().await?;
    // @show:start
    let ana = linear.create_user().name("Ana").await?;
    let team = linear.create_team().members(vec![&ana]).await?;
    let issue = ana
        .create_issue(json!({ "title": "Anything" }))
        .team(&team)
        .await?;
    let session = ana.delegate(&linear.app()).issue(&issue).await?;
    expect(&session)
        .to_have_activity()
        .r#type("thought")
        .await?;
    // The Rust SDK returns the activities as JSON.
    let before = session.activities().await?.as_array().map_or(0, Vec::len);

    let delivery = session.delivery().expect("the fake delivered the webhook");
    delivery.redeliver().await?;

    expect(&issue).to_have_session_state("complete").await?;
    let activities = session.activities().await?;
    let thoughts = activities
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["type"] == "thought")
        .count();
    assert!(thoughts <= before);
    // @show:end
    test_session.close().await
}
