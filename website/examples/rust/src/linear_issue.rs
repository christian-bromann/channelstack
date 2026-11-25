use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn an_issue_with_its_fields() -> Result<()> {
    let session = fixtures::session().await?;
    let linear = session.linear().await?;
    let ana = linear.create_user().name("Ana").await?;
    let ben = linear.create_user().name("Ben").admin(true).await?;
    let team = linear
        .create_team()
        .members(vec![&ana as &dyn Handle, &ben])
        .labels(vec!["incident"])
        .states(json!([{ "name": "Triage", "type": "triage" }]))
        .await?;
    // @show:start
    let issue = ana
        .create_issue(json!({
            "title": "API latency spike",
            "labels": ["incident"],
            "priority": 2,
            "state": "Triage",
            "assignee": ben.data(),
        }))
        .team(&team)
        .await?;
    // @show:end
    let _ = issue;
    session.close().await
}
