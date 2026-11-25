use channelstack::{Handle, Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_full_review_round_changes_requested_fixed_approved_merged() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
    // @show:start
    let ana = github.create_user().login("ana").await?;
    let ben = github.create_user().login("ben").await?;
    let repo = github
        .create_repo()
        .files("./fixtures/web")
        .collaborators(vec![&ana as &dyn Handle, &ben])
        .apps(vec![&github.app()])
        .await?;
    let pr = ana
        .open_pull_request(json!({
            "from": "feat",
            "draft": true,
            "changes": { "src/app.ts": "export const x = 1\n" },
        }))
        .repo(&repo)
        .await?;

    ana.mark_ready().pr(&pr).await?;
    ben.review(json!({
        "pr": pr.data(),
        "event": "REQUEST_CHANGES",
        "body": "@my-agent please address these",
        "comments": [{ "path": "src/app.ts", "line": 1, "body": "name this something clearer" }],
    }))
    .await?;

    let fix = pr.head_commit().await?;
    assert_eq!(fix.author()["name"], github.app().name());
    ben.review(json!({ "pr": pr.data(), "event": "APPROVE" }))
        .await?;
    ana.merge().pr(&pr).method("squash").await?;
    expect(&pr).to_be_merged().await?;
    // @show:end
    session.close().await
}
