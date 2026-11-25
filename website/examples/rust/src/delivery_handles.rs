use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn what_each_action_resolves_to() -> Result<()> {
    let test_session = fixtures::session().await?;
    let slack = test_session.slack().await?;
    let github = test_session.github().await?;
    let linear = test_session.linear().await?;
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    let ben = github.create_user().login("ben").await?;
    let repo = github
        .create_repo()
        .collaborators(vec![&ben as &dyn Handle])
        .apps(vec![&github.app()])
        .await?;
    let issue = ben
        .open_issue(json!({ "title": "Flaky test" }))
        .repo(&repo)
        .await?;
    let mo = linear.create_user().name("Mo").await?;
    let team = linear.create_team().members(vec![&mo]).await?;
    let ticket = mo
        .create_issue(json!({ "title": "Checkout fails on Safari" }))
        .team(&team)
        .await?;
    // @show:start
    let msg = ana.say("@my-agent hi").channel(&channel).await?;
    msg.delivery(); // the app_mention event_callback

    let comment = ben.comment("@my-agent investigate").issue(&issue).await?;
    comment.delivery(); // the issue_comment webhook

    let session = mo.delegate(&linear.app()).issue(&ticket).await?;
    session.delivery(); // the AgentSessionEvent that opened the session

    let command = ana
        .run_command("/deploy web staging")
        .channel(&channel)
        .await?;
    // a slash command, click, shortcut or modal submission resolves to its delivery
    // @show:end
    let _ = command;
    test_session.close().await
}
