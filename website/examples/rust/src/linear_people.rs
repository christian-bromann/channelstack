use channelstack::Result;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_people_a_linear_test_creates() -> Result<()> {
    let session = fixtures::session().await?;
    let linear = session.linear().await?;
    // @show:start
    let ana = linear.create_user().name("Ana").await?;
    let ben = linear.create_user().name("Ben").admin(true).await?;
    // @show:end
    let _ = (ana, ben);
    session.close().await
}
