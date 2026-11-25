use channelstack::{Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn delegating_an_issue_gets_a_response_in_its_session() -> Result<()> {
    let test_session = fixtures::session().await?;
    let linear = test_session.linear().await?;
    // @show:start
    let ana = linear.create_user().name("Ana").await?;
    let team = linear.create_team().members(vec![&ana]).await?;
    let issue = ana
        .create_issue(json!({ "title": "Checkout fails on Safari" }))
        .team(&team)
        .await?;

    let session = ana.delegate(&linear.app()).issue(&issue).await?;

    expect(&session)
        .to_have_activity()
        .r#type("response")
        .await?;
    expect(&issue).to_be_delegated_to(&linear.app()).await?;
    // @show:end
    test_session.close().await
}
