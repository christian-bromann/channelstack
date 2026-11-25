use channelstack::Result;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_people_a_notion_test_creates() -> Result<()> {
    let session = fixtures::session().await?;
    let notion = session.notion().await?;
    // @show:start
    let ana = notion.create_user().name("Ana").await?;
    let ben = notion
        .create_user()
        .name("Ben")
        .email("ben@example.com")
        .await?;
    // @show:end
    let _ = (ana, ben);
    session.close().await
}
