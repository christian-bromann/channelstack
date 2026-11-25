use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn pull_requests_and_pushes() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
    let ana = github.create_user().login("ana").await?;
    let repo = github
        .create_repo()
        .files("./fixtures/web")
        .collaborators(vec![&ana as &dyn Handle])
        .apps(vec![&github.app()])
        .await?;
    // @show:start
    let pr = ana
        .open_pull_request(json!({
            "from": "fix-login",
            "title": "Fix login redirect",
            "changes": { "src/login.ts": "export const redirect = '/home';\n" },
        }))
        .repo(&repo)
        .await?;

    let commit = ana
        .push(json!({ "src/app.ts": "export const broken = ;\n" }))
        .repo(&repo)
        .branch("fix-login")
        .message("wip")
        .await?;
    // @show:end
    let _ = (pr, commit);
    session.close().await
}
