use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn pages_and_rows_a_person_creates() -> Result<()> {
    let session = fixtures::session().await?;
    let notion = session.notion().await?;
    let ana = notion.create_user().name("Ana").await?;
    let space = notion
        .create_page()
        .title("Engineering")
        .connections(vec![&notion.app()])
        .await?;
    let tasks = notion
        .create_database()
        .title("Tasks")
        .properties(json!({
            "Name": "title",
            "Status": { "status": ["Todo", "Ready for agent", "Done"] },
        }))
        .connections(vec![&notion.app()])
        .await?;
    // @show:start
    let report = ana
        .create_page(json!({
            "title": "Checkout outage",
            "parent": space.data(),
            "content": "Started 09:12 UTC",
        }))
        .await?;

    let row = ana
        .add_row(json!({ "Name": "Migrate to Postgres 17", "Status": "Todo" }))
        .database(&tasks)
        .await?;
    ana.set_property("Status", "Ready for agent")
        .page(&row)
        .await?;
    // @show:end
    let _ = report;
    session.close().await
}
