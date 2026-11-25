use channelstack::Result;
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_person_signed_in_with_a_saved_browser_session() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack
        .create_user()
        .name("Ana")
        .browser(json!({ "storageState": ".auth/ana-slack.json" }))
        .await?;
    // @show:end
    let _ = ana;
    session.close().await
}
