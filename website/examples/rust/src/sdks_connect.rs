// @show:start
use channelstack::{Handle, Mode, connect};

#[tokio::main]
async fn main() -> channelstack::Result<()> {
    let client = connect(Mode::Auto).await?;
    let session = client.open_session().name("example").send().await?;

    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;

    let msg = ana.say("@my-agent hi").channel(&channel).await?;
    let reply = msg.thread().wait_for_reply().from("my-agent").await?;
    println!("{}", reply.text());

    session.close().await?;
    client.close().await;
    Ok(())
}
// @show:end

#[test]
#[ignore = "needs a running agent"]
fn runs() -> channelstack::Result<()> {
    main()
}
