use channelstack::{Handle, Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_redelivered_webhook_is_answered_once() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
    let ana = github.create_user().login("ana").await?;
    let repo = github
        .create_repo()
        .collaborators(vec![&ana as &dyn Handle])
        .apps(vec![&github.app()])
        .await?;
    let issue = ana
        .open_issue(json!({ "title": "Flaky test" }))
        .repo(&repo)
        .await?;
    // @show:start
    let comment = ana.comment("@my-agent investigate").issue(&issue).await?;
    expect(&issue).to_have_comment_from(&github.app()).await?;

    let delivery = comment.delivery().expect("the fake delivered the comment");
    delivery.redeliver().await?;
    expect(&issue)
        .to_have_comments_from(&github.app(), 1)
        .quiet_for("2s")
        .await?;
    // @show:end
    session.close().await
}
