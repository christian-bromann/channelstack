use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn reviews_review_comments_and_merging() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
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
    // @show:start
    ana.mark_ready().pr(&pr).await?;
    ben.review(json!({
        "pr": pr.data(),
        "event": "REQUEST_CHANGES",
        "body": "@my-agent please address these",
        "comments": [{ "path": "src/app.ts", "line": 1, "body": "name this something clearer" }],
    }))
    .await?;

    let inline = ana
        .review_comment("@my-agent why is this exported?")
        .pr(&pr)
        .path("src/app.ts")
        .line(1)
        .await?;
    ana.reply("thanks").comment(&inline).await?;
    ana.resolve().comment(&inline).await?;

    ana.request_review(vec![&ben]).pr(&pr).await?;
    ana.merge().pr(&pr).method("squash").await?;
    // @show:end
    session.close().await
}
