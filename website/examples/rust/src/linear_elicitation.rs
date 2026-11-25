use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn answering_the_agent_and_prompting_it_again() -> Result<()> {
    let test_session = fixtures::session().await?;
    let linear = test_session.linear().await?;
    let ana = linear.create_user().name("Ana").await?;
    let team = linear
        .create_team()
        .members(vec![&ana as &dyn Handle])
        .await?;
    let issue = ana
        .create_issue(json!({ "title": "Fix the login bug" }))
        .team(&team)
        .await?;
    let session = ana.delegate(&linear.app()).issue(&issue).await?;
    // @show:start
    let question = session.wait_for_activity().r#type("elicitation").await?;
    ana.answer("Only Safari 18").elicitation(&question).await?;

    ana.prompt("also update the docs").session(&session).await?;
    // @show:end
    test_session.close().await
}
