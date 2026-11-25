use channelstack::{Handle, Result, SlackConversation, SlackFixture, SlackUser};

use crate::fixtures;

// @show:start
// Rust has no fixtures to extend: shared people and places are helpers each test calls.
pub async fn ana(slack: &SlackFixture) -> Result<SlackUser> {
    slack.create_user().name("Ana").await
}

pub async fn support(slack: &SlackFixture, ana: &SlackUser) -> Result<SlackConversation> {
    slack
        .create_channel()
        .name("support")
        .participants(vec![ana as &dyn Handle, &slack.app()])
        .await
}
// @show:end

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_helpers_make_ana_and_support() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = ana(&slack).await?;
    support(&slack, &ana).await?;
    session.close().await
}
