use channelstack::Result;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_people_a_slack_test_creates() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack.create_user().name("Ana").await?;
    let ben = slack.create_user().name("Ben").admin(true).await?;
    let deploy_bot = slack.create_user().name("deploy-bot").bot(true).await?;
    let cara = slack.create_user().name("Cara").id("U0ADMIN01").await?;
    // @show:end
    let _ = (ana, ben, deploy_bot, cara);
    session.close().await
}
