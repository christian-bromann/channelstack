use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn what_people_do_to_an_issue() -> Result<()> {
    let session = fixtures::session().await?;
    let linear = session.linear().await?;
    let ana = linear.create_user().name("Ana").await?;
    let ben = linear.create_user().name("Ben").await?;
    let team = linear
        .create_team()
        .members(vec![&ana as &dyn Handle, &ben])
        .labels(vec!["incident"])
        .await?;
    let issue = ana
        .create_issue(json!({ "title": "API latency spike" }))
        .team(&team)
        .await?;
    // @show:start
    ana.set_state("In Progress").issue(&issue).await?;
    ana.assign(&ben).issue(&issue).await?;
    ana.label(vec!["incident"]).issue(&issue).await?;
    ana.edit_issue(json!({ "priority": 1 }))
        .issue(&issue)
        .await?;

    let comment = ana
        .comment("Is this still happening?")
        .issue(&issue)
        .await?;
    ana.reply("@my-agent can you check the logs?")
        .comment(&comment)
        .await?;
    ana.edit("Is this still happening on Safari?")
        .comment(&comment)
        .await?;
    // @show:end
    session.close().await
}
