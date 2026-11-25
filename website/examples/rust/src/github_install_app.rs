use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_app_hears_about_a_repository_once_its_installed() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
    let ana = github.create_user().login("ana").await?;
    // @show:start
    let repo = github
        .create_repo()
        .collaborators(vec![&ana as &dyn Handle])
        .await?; // not installed
    let issue = ana
        .open_issue(json!({ "title": "Hello?" }))
        .repo(&repo)
        .await?;
    let comment = ana.comment("@my-agent ping").issue(&issue).await?;
    assert!(comment.delivery().is_none());

    repo.install_app(&github.app()).await?; // sends installation_repositories
    // @show:end
    session.close().await
}
