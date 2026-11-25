//! `expect(…)` against a server the SDK starts (`Mode::Start`, with `CHANNELSTACK_SERVER_BIN`): checks
//! that pass and fail, a negative one, an exact count, a delivery and the agent's calls, and a pattern
//! the server evaluates (a Notion anchor). No agent runs, so people say everything, and Slack
//! delivers to an endpoint that only answers 200.
//! `pnpm test:rust` sets the binary; without it, the test says so and passes.

use std::io::{BufRead, BufReader, Read, Write};

use channelstack::{Error, Handle, Mode, Regex, connect, expect};

/// An endpoint that acknowledges every request with 200 and nothing else: where Slack delivers.
fn acknowledging_endpoint() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let url = format!("http://{}/slack/events", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(&stream);
            let mut length = 0;
            let mut line = String::new();
            // The headers, then the body they announce, so the answer comes after the whole request.
            while reader.read_line(&mut line).is_ok_and(|read| read > 2) {
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    length = value.trim().parse().unwrap_or(0);
                }
                line.clear();
            }
            let _ = reader.take(length).read_to_end(&mut Vec::new());
            let _ = (&stream)
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
    });
    url
}

/// The message of a failed check.
fn failure(result: channelstack::Result<()>) -> String {
    match result {
        Err(Error::Expectation(message)) => message,
        other => panic!("expected a failed check, got {other:?}"),
    }
}

#[tokio::test]
async fn the_matchers() -> channelstack::Result<()> {
    if std::env::var("CHANNELSTACK_SERVER_BIN").is_err() {
        eprintln!("skipped: set CHANNELSTACK_SERVER_BIN (pnpm test:rust does)");
        return Ok(());
    }
    // SAFETY: this is the only test in its binary, and nothing else runs yet that reads the environment.
    unsafe { std::env::set_var("CHANNELSTACK_SLACK_WEBHOOK_URL", acknowledging_endpoint()) };
    let client = connect(Mode::Start).await?;
    let session = client.open_session().name("rust-expect").send().await?;
    let slack = session.slack().await?;
    let carla = slack.create_user().name("Carla").await?;
    let dan = slack.create_user().name("Dan").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&carla as &dyn Handle, &dan, &slack.app()])
        .await?;
    let asked = carla.say("@my-agent hi").channel(&channel).await?;
    dan.reply("first").thread(&asked).await?;
    dan.reply("second, with a Rate Limit")
        .thread(&asked)
        .await?;
    let thread = asked.thread();

    // A positive check that holds, by handle and by name, with text and a pattern.
    expect(&thread)
        .to_have_reply_from(&dan)
        .text("first")
        .await?;
    expect(&thread)
        .to_have_reply_from("Dan")
        .text(Regex::new("(?i)rate limit")?)
        .await?;
    expect(&channel)
        .to_contain_text("second")
        .from(&dan)
        .await?;

    // One that doesn't: it says what the thread has.
    let failed = failure(
        expect(&thread)
            .to_have_reply_from("my-agent")
            .timeout("300ms")
            .await,
    );
    assert_eq!(
        failed,
        "Expected a reply from my-agent. The thread has:\n  Dan: first\n  Dan: second, with a Rate Limit"
    );

    // A negative check and exact counts, once the session is quiet.
    expect(&thread)
        .not_to_have_reply_from("my-agent")
        .quiet_for("50ms")
        .await?;
    expect(&thread)
        .to_have_replies_from(&dan, 2)
        .quiet_for("50ms")
        .await?;
    let failed = failure(
        expect(&thread)
            .to_have_replies_from(&dan, 1)
            .quiet_for("50ms")
            .await,
    );
    assert!(
        failed.starts_with("Expected exactly 1 reply from Dan, found 2:\n  Dan: first"),
        "{failed}"
    );
    expect(&channel)
        .not_to_have_channel_message_from(&slack.app())
        .quiet_for("50ms")
        .await?;
    expect(&channel)
        .to_have_channel_message_from(&carla)
        .await?;

    // The mention was delivered and acknowledged at once, so it needed no retry.
    let delivery = asked
        .delivery()
        .expect("a mention is delivered to the agent");
    expect(&delivery).to_be_accepted().within("3s").await?;
    expect(&delivery)
        .not_to_be_retried()
        .quiet_for("50ms")
        .await?;
    let failed = failure(expect(&delivery).to_be_retried().timeout("300ms").await);
    assert_eq!(
        failed,
        format!(
            "Expected delivery {} to be retried, it was retried 0 times",
            delivery.id()
        )
    );

    // And the agent made no API calls.
    expect(&slack)
        .not_to_have_received_call("chat.postMessage")
        .quiet_for("50ms")
        .await?;

    // A case-insensitive `Regex` the server evaluates: Notion anchors a comment to the block it finds.
    let notion = session.notion().await?;
    let ana = notion.create_user().name("Ana").await?;
    let page = notion
        .create_page()
        .title("Roadmap")
        .content("# Q1\n- ship search\n- ship billing")
        .await?;
    let anchored = ana
        .comment("Is this still on?")
        .page(&page)
        .anchor(Regex::new("(?i)SHIP SEARCH")?)
        .await?;
    assert_eq!(
        anchored.discussion().anchor().as_deref(),
        Some("ship search")
    );

    session.close().await?;
    client.close().await;
    Ok(())
}
