use channelstack::{Handle, Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn stop_ends_the_session() -> Result<()> {
    let test_session = fixtures::session().await?;
    let linear = test_session.linear().await?;
    let ana = linear.create_user().name("Ana").await?;
    let team = linear
        .create_team()
        .members(vec![&ana as &dyn Handle])
        .await?;
    let issue = ana
        .create_issue(json!({ "title": "Checkout fails on Safari" }))
        .team(&team)
        .await?;
    let session = ana.delegate(&linear.app()).issue(&issue).await?;
    // @show:start
    expect(&session)
        .to_have_activity()
        .r#type("thought")
        .await?;
    ana.stop().session(&session).await?;
    expect(&session).to_have_session_state("complete").await?;
    // @show:end
    test_session.close().await
}
