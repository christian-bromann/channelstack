use channelstack::Result;
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn editing_a_page() -> Result<()> {
    let session = fixtures::session().await?;
    let notion = session.notion().await?;
    let ana = notion.create_user().name("Ana").await?;
    let page = notion
        .create_page()
        .title("Spec")
        .content("# Spec\nTODO: billing")
        .connections(vec![&notion.app()])
        .await?;
    // @show:start
    ana.edit(json!({ "append": "## Open questions\n- who owns billing?" }))
        .page(&page)
        .await?;
    ana.edit(json!({ "replace": "# Draft\nStarting over." }))
        .page(&page)
        .await?;
    ana.rename("Spec v2").page(&page).await?;
    ana.mention(&notion.app())
        .page(&page)
        .in_block("TODO")
        .await?;
    // @show:end
    session.close().await
}
