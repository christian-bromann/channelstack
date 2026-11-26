//! The home page's Notion example (website/samples/notion.test.ts), in Rust.
// @show:start
use channelstack::{Mode, Result, connect, expect};

#[ignore = "needs a running agent"] // @hide
#[tokio::test]
async fn answers_a_mention_in_the_same_discussion() -> Result<()> {
    let client = connect(Mode::Auto).await?;
    let test_session = client.open_session().send().await?;
    let notion = test_session.notion().await?;
    let ana = notion.create_user().name("Ana").await?;
    // [!step 1]
    let page = notion
        .create_page()
        .title("Roadmap")
        .content("# Q1\n- ship search")
        .connections(vec![&notion.app()])
        .await?;

    // [!step 2]
    let comment = ana.comment("@my-agent summarize").page(&page).await?;
    // [!step 3]
    let thread = comment.discussion();
    expect(&thread)
        .to_have_comment_from("my-agent")
        .text("search")
        .await?;
    // [!step 4]
    expect(&thread).to_have_comments_from("my-agent", 1).await?;

    test_session.close().await
}
// @show:end
