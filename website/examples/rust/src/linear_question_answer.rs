use channelstack::{Handle, Regex, Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_agent_asks_a_question_and_continues_after_the_answer() -> Result<()> {
    let test_session = fixtures::session().await?;
    let linear = test_session.linear().await?;
    // @show:start
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

    let question = session.wait_for_activity().r#type("elicitation").await?;
    expect(&issue)
        .to_have_session_state("awaitingInput")
        .await?;
    ana.answer("Only Safari 18").elicitation(&question).await?;

    expect(&session)
        .to_have_activity()
        .r#type("response")
        .text(Regex::new("(?i)safari 18")?)
        .await?;
    expect(&linear)
        .to_have_received_call("agentActivityCreate")
        .await?;
    // The Rust SDK returns the calls as JSON.
    assert_eq!(linear.calls().error(true).await?, json!([]));
    // @show:end
    test_session.close().await
}
