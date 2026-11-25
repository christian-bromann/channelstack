use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_repository_with_files_collaborators_labels_and_the_app() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
    let ana = github.create_user().login("ana").await?;
    let ben = github
        .create_user()
        .login("ben")
        .role("admin")
        .name("Ben Ortiz")
        .await?;
    // @show:start
    let repo = github
        .create_repo()
        .name("web")
        .files("./fixtures/web")
        .collaborators(json!([ana.data(), { "user": ben.data(), "permission": "maintain" }]))
        .labels(json!(["bug", { "name": "agent:fix", "color": "5319e7" }]))
        .apps(vec![&github.app()])
        .await?;
    // @show:end
    let _ = repo;
    session.close().await
}
