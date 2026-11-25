use channelstack::{Handle, Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn delegating_an_issue_opens_one_session_with_a_first_thought() -> Result<()> {
    let test_session = fixtures::session().await?;
    let linear = test_session.linear().await?;
    // @show:start
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

    expect(&session)
        .to_have_activity()
        .r#type("thought")
        .timeout("10s")
        .await?;
    expect(&issue).to_be_delegated_to(&linear.app()).await?;
    // The Rust SDK returns the sessions as JSON.
    let sessions = issue.sessions().await?;
    assert_eq!(sessions.as_array().map(Vec::len), Some(1));
    // @show:end
    test_session.close().await
}
