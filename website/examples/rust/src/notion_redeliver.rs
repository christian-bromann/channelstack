use channelstack::{Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn notions_deliveries_redelivered_and_forged() -> Result<()> {
    let session = fixtures::session().await?;
    let notion = session.notion().await?;
    let ana = notion.create_user().name("Ana").await?;
    let page = notion
        .create_page()
        .title("Roadmap")
        .connections(vec![&notion.app()])
        .await?;
    // @show:start
    let comment = ana.comment("@my-agent hi").page(&page).await?;
    let delivery = comment.delivery().expect("the fake delivered the comment");

    delivery.redeliver().await?; // the next attempt_number, signed again
    delivery.resend().bad_signature(true).await?; // signed with the wrong token
    expect(&delivery).to_be_rejected().await?;
    // @show:end
    session.close().await
}
