use channelstack::{Regex, Result, expect};
use serde_json::json;

use crate::fixtures;

// @show:start
/// What the model streams, a piece at a time.
const NOTES: [&str; 4] = [
    "# Release notes for 0.10\n\n",
    "## What changed\n\nThe delivery queue now retries a slow acknowledgement the way the platform does.\n\n",
    "## What to do\n\nUpdate, run the tests once and read the new failure messages.\n\n",
    "## Thanks\n\nTo everyone who sent the transcript of a conversation that went wrong.\n",
];

#[tokio::test]
#[ignore = "needs a running agent"]
async fn streams_a_reply_and_shows_a_status_while_working() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let openai = session.openai().await?;
    openai
        .respond(json!({ "text": NOTES }))
        .timing(json!({ "firstToken": "700ms", "betweenChunks": "250ms" }))
        .await?;
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
    expect(&openai).to_have_sent(msg.text()).await?;
    session.close().await
}

#[tokio::test]
#[ignore = "needs a running agent"]
async fn stop_ends_the_stream_and_cancels_the_model() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let openai = session.openai().await?;
    let ai = openai
        .respond(
            json!({ "text": "More detail, for those who asked. ".repeat(40), "pauseAfter": 3 }),
        )
        .await?;
    let ana = slack.create_user().name("Ana").await?;
    let msg = ana
        .say("write a long report on Q3")
        .to(&slack.app())
        .await?;
    let call = ai.wait_for_pause().await?;
    expect(&msg.thread())
        .to_have_streaming_reply_from("my-agent")
        .await?;

    ana.stop().thread(&msg).await?;

    expect(&msg.thread()).to_have_status("stopped").await?;
    expect(&msg.thread())
        .to_have_replies_from("my-agent", 1)
        .await?;
    expect(&call).to_be_aborted().await?;
    session.close().await
}
// @show:end
