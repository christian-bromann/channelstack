use channelstack::{Handle, Result};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_channels_a_slack_test_creates() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let ben = slack.create_user().name("Ben").admin(true).await?;
    // @show:start
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &ben, &slack.app()])
        .await?;
    let incidents = slack
        .create_channel()
        .name("incidents")
        .private(true)
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    // @show:end
    let _ = (channel, incidents);
    session.close().await
}
