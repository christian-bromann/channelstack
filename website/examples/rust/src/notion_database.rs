use channelstack::{Handle, NotionPage, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_database_a_notion_test_creates() -> Result<()> {
    let session = fixtures::session().await?;
    let notion = session.notion().await?;
    // @show:start
    let tasks = notion
        .create_database()
        .title("Tasks")
        .properties(json!({
            "Name": "title",
            "Status": { "status": ["Todo", "Ready for agent", "Done"] },
            "Estimate": "number",
        }))
        .rows(json!([{ "Name": "Write the onboarding guide", "Status": "Todo" }]))
        .connections(vec![&notion.app()])
        .await?;
    // The rows come back as JSON: wrap them as page handles to act on them.
    let rows = tasks
        .rows(json!({ "Name": "Write the onboarding guide" }))
        .await?;
    let row = NotionPage::wrap_vec(tasks.ctx(), rows)?.remove(0);
    // @show:end
    let _ = row;
    session.close().await
}
