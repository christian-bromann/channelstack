use channelstack::{Handle, Regex, Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_mention_in_an_issue_gets_one_comment() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
    // @show:start
    let ana = github.create_user().login("ana").await?;
    let repo = github
        .create_repo()
        .collaborators(vec![&ana as &dyn Handle])
        .apps(vec![&github.app()])
        .await?;
    let issue = ana
        .open_issue(json!({ "title": "Login fails on Safari" }))
        .repo(&repo)
        .await?;

    ana.comment("@my-agent can you triage this?")
        .issue(&issue)
        .await?;

    expect(&issue)
        .to_have_comment_from(&github.app())
        .text(Regex::new("(?i)triage")?)
        .await?;
    expect(&issue)
        .to_have_comments_from(&github.app(), 1)
        .quiet_for("2s")
        .await?;
    // @show:end
    session.close().await
}
