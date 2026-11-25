//! The typed API against a server the SDK starts (`Mode::Start`, with `CHANNELSTACK_SERVER_BIN`):
//! builders, getters, refusals as `Error::Api`, and a wait. `pnpm test:rust` sets the binary; without
//! it, the test says so and passes.

use channelstack::{Error, Handle, Mode, codes, connect};

#[tokio::test]
async fn the_typed_api() -> channelstack::Result<()> {
    if std::env::var("CHANNELSTACK_SERVER_BIN").is_err() {
        eprintln!("skipped: set CHANNELSTACK_SERVER_BIN (pnpm test:rust does)");
        return Ok(());
    }
    let client = connect(Mode::Start).await?;
    let session = client.open_session().name("rust").send().await?;

    // Echo: a person says something in a room the app is in, and it is read back.
    let echo = session.echo().await?;
    let ana = echo.create_user().name("Ana").await?;
    let ben = echo.create_user().name("Ben").await?;
    let app = echo.app();
    let room = echo
        .create_room()
        .participants(vec![&ana as &dyn Handle, &app])
        .await?;
    assert!(room.name().starts_with("test-"));
    let message = ana.say("hello").room(&room).await?;
    // An echo message is data, not a handle: it comes back as JSON.
    assert_eq!(message["text"], "hello");
    assert_eq!(message["author"]["id"], ana.id().as_str());
    let page = room.messages().await?;
    assert_eq!(page["messages"][0]["text"], "hello");

    // A refusal is the protocol's code.
    match ben.say("hi").room(&room).await {
        Err(Error::Api { code, .. }) => assert_eq!(code, codes::NOT_IN_ROOM),
        other => panic!("expected not_in_room, got {other:?}"),
    }

    // Slack: a wait gives up when nothing comes (no agent runs here).
    let slack = session.slack().await?;
    let carla = slack.create_user().name("Carla").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&carla as &dyn Handle, &slack.app()])
        .await?;
    let asked = carla.say("@my-agent hi").channel(&channel).await?;
    // A Slack message is a handle; its author is a user or the app, so it is JSON.
    assert_eq!(asked.author()["kind"], "user");
    // Slack's own text: the mention is a real one (`<@U…>`).
    assert!(
        asked.text().starts_with("<@U") && asked.text().ends_with("> hi"),
        "{}",
        asked.text()
    );
    match asked
        .thread()
        .wait_for_reply()
        .from("my-agent")
        .timeout("300ms")
        .await
    {
        Err(Error::Timeout { what, .. }) => assert!(what.contains("from my-agent"), "{what}"),
        other => panic!(
            "expected a timeout, got {:?}",
            other.map(|reply| reply.text())
        ),
    }

    // A field's handle is the same handle every time: the second wait, through `thread()` again,
    // waits for something new instead of returning the first reply again.
    let dan = slack.create_user().name("Dan").await?;
    carla.invite(&dan).channel(&channel).await?;
    dan.reply("first").thread(&asked).await?;
    dan.reply("second").thread(&asked).await?;
    let first = asked.thread().wait_for_reply().from(&dan).await?;
    let second = asked.thread().wait_for_reply().from(&dan).await?;
    assert_eq!(
        (first.text(), second.text()),
        ("first".into(), "second".into())
    );
    // The latest reply is read once the session is quiet, after a first match.
    let latest = asked
        .thread()
        .latest_reply()
        .from("Dan")
        .quiet_for("50ms")
        .await?;
    assert_eq!(latest.text(), "second");

    session.close().await?;
    client.close().await;
    Ok(())
}
