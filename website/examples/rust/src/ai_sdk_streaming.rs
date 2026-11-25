use channelstack::{Regex, Result, expect};

use crate::fixtures;

// @show:start
#[tokio::test]
#[ignore = "needs a running agent"]
async fn streams_a_reply_and_shows_a_status_while_working() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let msg = ana
        .say("write the release notes for 0.10")
        .to(&slack.app())
        .await?;

    expect(&msg.thread()).to_have_status("working").await?;
    expect(&msg.thread())
        .to_have_status_text(Regex::new("(?i)thinking")?)
        .await?;
    expect(&msg.thread())
        .to_have_streaming_reply_from("my-agent")
        .await?;
    expect(&msg.thread()).to_have_status("idle").await?;

    let reply = msg.thread().latest_reply().from("my-agent").await?;
    let stream = reply.stream().expect("a streamed reply").ended().await?;
    assert_eq!(stream.state(), "completed");
    session.close().await
}

#[tokio::test]
#[ignore = "needs a running agent"]
async fn stop_ends_the_stream_and_the_agent_stays_quiet() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let msg = ana
        .say("write a long report on Q3")
        .to(&slack.app())
        .await?;
    expect(&msg.thread())
        .to_have_streaming_reply_from("my-agent")
        .await?;

    ana.stop().thread(&msg).await?;

    expect(&msg.thread()).to_have_status("stopped").await?;
    expect(&msg.thread())
        .to_have_replies_from("my-agent", 1)
        .await?;
    session.close().await
}
// @show:end
