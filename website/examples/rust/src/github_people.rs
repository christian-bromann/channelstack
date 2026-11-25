use channelstack::Result;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_people_a_github_test_creates() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
    // @show:start
    let ana = github.create_user().login("ana").await?;
    let ben = github
        .create_user()
        .login("ben")
        .role("admin")
        .name("Ben Ortiz")
        .await?;
    // @show:end
    let _ = (ana, ben);
    session.close().await
}
