use channelstack::{Handle, Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_ways_an_issue_reaches_the_agent() -> Result<()> {
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
    // @show:start
    let session = ana.delegate(&linear.app()).issue(&issue).await?;

    let issue2 = ana
        .create_issue(json!({ "title": "Bump the Node version", "delegate": linear.app().data() }))
        .team(&team)
        .await?;
    let session2 = issue2.session().await?;

    let comment = ana
        .comment("@my-agent can you take a look?")
        .issue(&issue)
        .await?;
    let opened = comment.session().expect("the mention opened a session");
    expect(&opened)
        .to_have_activity()
        .r#type("response")
        .await?;

    ana.undelegate().issue(&issue).await?;
    // @show:end
    let _ = (session, session2);
    test_session.close().await
}
