use channelstack::{Handle, Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_checks_own_timeout_and_quiet_for() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let github = session.github().await?;
    let ana = slack.create_user().name("Ana").await?;
    let msg = ana.say("@my-agent hi").to(&slack.app()).await?;
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
    ben.comment("@my-agent investigate").issue(&issue).await?;
    // @show:start
    expect(&issue)
        .to_have_comments_from(&github.app(), 1)
        .quiet_for("2s")
        .await?;
    expect(&msg.thread())
        .to_have_reply_from("my-agent")
        .timeout("30s")
        .await?;
    // @show:end
    session.close().await
}
