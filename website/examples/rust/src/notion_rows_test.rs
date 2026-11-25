use channelstack::{Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn database_rows_the_agent_fills_in_a_property() -> Result<()> {
    let session = fixtures::session().await?;
    let notion = session.notion().await?;
    // @show:start
    let ana = notion.create_user().name("Ana").await?;
    let tasks = notion
        .create_database()
        .title("Tasks")
        .properties(json!({
            "Name": "title",
            "Status": { "status": ["Todo", "In progress", "Done"] },
            "Estimate": "number",
        }))
        .connections(vec![&notion.app()])
        .await?;

    let row = ana
        .add_row(json!({ "Name": "Migrate to Postgres 17", "Status": "Todo" }))
        .database(&tasks)
        .await?;
    let comment = ana.comment("@my-agent estimate this").page(&row).await?;

    expect(&comment.discussion())
        .to_have_comments_from(&notion.app(), 1)
        .await?;
    // Rust has no `expect.any(Number)`: once the agent is quiet, read the property and check its type.
    assert!(row.property("Estimate").await?.is_number());
    expect(&notion)
        .to_have_received_call("pages.update")
        .await?;
    // @show:end
    session.close().await
}
