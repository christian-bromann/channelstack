use channelstack::Result;
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_pages_a_notion_test_creates() -> Result<()> {
    let session = fixtures::session().await?;
    let notion = session.notion().await?;
    // @show:start
    let space = notion
        .create_page()
        .title("Engineering")
        .connections(vec![&notion.app()])
        .await?;
    let spec = notion
        .create_page()
        .title("Spec")
        .parent(&space)
        .content(json!({ "path": "./fixtures/spec.md" }))
        .icon("📐")
        .await?;
    // @show:end
    let _ = spec;
    session.close().await
}
