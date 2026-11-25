use channelstack::{Handle, Result, SlackDelivery, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_uninstall_is_handled() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    // The Rust SDK returns the deliveries as JSON: make them handles to check them.
    let deliveries = SlackDelivery::wrap_vec(slack.ctx(), slack.uninstall_app().await?)?;
    for delivery in &deliveries {
        expect(delivery).to_be_accepted().await?;
    }
    // @show:end
    session.close().await
}
