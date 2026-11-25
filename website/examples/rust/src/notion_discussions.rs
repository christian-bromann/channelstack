use channelstack::Result;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn comments_and_discussions() -> Result<()> {
    let session = fixtures::session().await?;
    let notion = session.notion().await?;
    let ana = notion.create_user().name("Ana").await?;
    let page = notion
        .create_page()
        .title("API design")
        .content("# Rate limits\n100 requests a minute.")
        .connections(vec![&notion.app()])
        .await?;
    // @show:start
    let comment = ana
        .comment("@my-agent is this enough for the mobile app?")
        .page(&page)
        .anchor("Rate limits")
        .await?;
    comment
        .discussion()
        .wait_for_comment()
        .from(&notion.app())
        .await?;

    ana.reply("@my-agent and what should we change?")
        .discussion(&comment.discussion())
        .await?;
    ana.edit_comment("@my-agent is this enough for the iOS app?")
        .comment(&comment)
        .await?;
    ana.resolve().discussion(&comment.discussion()).await?;
    // @show:end
    session.close().await
}
