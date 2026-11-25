use channelstack::Result;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_transcript_a_person_reads() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    // @show:start
    let msg = ana.say("what's 2 + 2?").to(&slack.app()).await?;
    msg.thread().latest_reply().from("my-agent").await?;

    let transcript = msg.thread().transcript().await?;
    // No snapshots in Rust's test harness: compare with the conversation as a person reads it.
    assert_eq!(
        transcript["text"],
        "Ana: what's 2 + 2?\n  my-agent: 2 + 2 is 4."
    );
    // @show:end
    session.close().await
}
