use channelstack::Result;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_page_the_integration_isnt_connected_to() -> Result<()> {
    let session = fixtures::session().await?;
    let notion = session.notion().await?;
    let ana = notion.create_user().name("Ana").await?;
    // @show:start
    let notes = notion.create_page().title("Private notes").await?; // not connected
    let comment = ana.comment("@my-agent read this").page(&notes).await?;
    assert!(comment.delivery().is_none());

    ana.connect(&notion.app()).page(&notes).await?;
    // @show:end
    session.close().await
}
