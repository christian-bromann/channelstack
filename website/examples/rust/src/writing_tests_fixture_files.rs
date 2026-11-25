use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn files_and_fixture_directories() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
    let notion = session.notion().await?;
    let ana = github.create_user().login("ana").await?;
    // @show:start
    let repo = github
        .create_repo()
        .files("./fixtures/web")
        .collaborators(vec![&ana as &dyn Handle])
        .apps(vec![&github.app()])
        .await?;

    let pr = ana
        .open_pull_request(json!({
            "from": "fix-login",
            "title": "Fix login redirect",
            "changes": { "src/login.ts": "export const redirect = '/home';\n" },
        }))
        .repo(&repo)
        .await?;

    let spec = notion
        .create_page()
        .title("Spec")
        .content(json!({ "path": "./fixtures/spec.md" }))
        .connections(vec![&notion.app()])
        .await?;
    // @show:end
    let _ = (pr, spec);
    session.close().await
}
