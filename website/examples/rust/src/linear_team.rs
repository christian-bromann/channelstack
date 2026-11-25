use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_team_with_its_labels_and_workflow_states() -> Result<()> {
    let session = fixtures::session().await?;
    let linear = session.linear().await?;
    let ana = linear.create_user().name("Ana").await?;
    let ben = linear.create_user().name("Ben").admin(true).await?;
    // @show:start
    let team = linear
        .create_team()
        .key("OPS")
        .members(vec![&ana as &dyn Handle, &ben])
        .labels(vec!["incident"])
        .states(json!([
            { "name": "Triage", "type": "triage" },
            { "name": "Investigating", "type": "started" },
            { "name": "Resolved", "type": "completed" },
        ]))
        .await?;
    // @show:end
    let _ = team;
    session.close().await
}
