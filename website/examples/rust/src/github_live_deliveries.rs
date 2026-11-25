use channelstack::runtime::wait::wait_for;
use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn live_the_apps_delivery_log() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
    let ana = github.create_user().login("ana").await?;
    let repo = github
        .create_repo()
        .collaborators(vec![&ana as &dyn Handle])
        .apps(vec![&github.app()])
        .await?;
    let issue = ana
        .open_issue(json!({ "title": "Hello?" }))
        .repo(&repo)
        .await?;
    ana.comment("@my-agent ping").issue(&issue).await?;
    // @show:start
    // No expect.poll in Rust: the SDK's own polling loop reads until there is something.
    wait_for(
        "an issue_comment delivery in the App's log",
        &json!("30s"),
        || async {
            let logged = github
                .deliveries()
                .r#type("issue_comment")
                .resource(&repo)
                .await?;
            Ok(logged
                .as_array()
                .filter(|logged| !logged.is_empty())
                .cloned())
        },
    )
    .await?;
    // @show:end
    session.close().await
}
