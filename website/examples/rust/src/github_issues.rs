use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn what_people_do_on_an_issue() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
    let ana = github.create_user().login("ana").await?;
    let ben = github.create_user().login("ben").await?;
    let repo = github
        .create_repo()
        .collaborators(vec![&ana as &dyn Handle, &ben])
        .labels(vec!["bug", "agent:fix"])
        .apps(vec![&github.app()])
        .await?;
    // @show:start
    let issue = ana
        .open_issue(json!({ "title": "Typo in the README", "labels": ["bug"] }))
        .repo(&repo)
        .await?;

    ana.comment("@my-agent is this a duplicate?")
        .issue(&issue)
        .await?;
    ana.label("agent:fix").issue(&issue).await?;
    ana.assign(vec![&ben]).issue(&issue).await?;
    ana.edit_issue(json!({ "title": "Typo in README.md" }))
        .issue(&issue)
        .await?;
    ana.close().issue(&issue).await?;
    // @show:end
    session.close().await
}
