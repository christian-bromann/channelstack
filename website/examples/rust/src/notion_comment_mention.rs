use channelstack::{Result, expect, Regex};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_mention_in_a_page_comment_gets_a_reply_in_the_same_discussion() -> Result<()> {
    let session = fixtures::session().await?;
    let notion = session.notion().await?;
    // @show:start
    let ana = notion.create_user().name("Ana").await?;
    let page = notion
        .create_page()
        .title("Roadmap")
        .content("# Q1\n- ship search\n- ship billing")
        .connections(vec![&notion.app()])
        .await?;

    let comment = ana
        .comment("@my-agent summarize this page")
        .page(&page)
        .await?;

    expect(&comment.discussion())
        .to_have_comment_from("my-agent")
        .text(Regex::new("(?i)search")?)
        .await?;
    expect(&comment.discussion())
        .to_have_comments_from(&notion.app(), 1)
        .await?;
    // @show:end
    session.close().await
}
