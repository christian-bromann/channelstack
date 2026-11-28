# channelstack for Rust

The Rust SDK of [channelstack](https://channelstack.dev), a test harness for the apps and agents you build for Slack, GitHub, Linear, Notion, Resend, Gmail and Discord. channelstack runs fake versions of those platforms on your machine, and of OpenAI's API for your agent's model. Your code scripts the people, your app answers through its real code path, and you check what a person would see, with the matchers in `channelstack::expect`.

## Install

```bash
cargo add channelstack
cargo add tokio --features macros,rt-multi-thread
```

The crate uses edition 2024 and runs on Tokio. It doesn't bundle or download the server. It finds it at `CHANNELSTACK_SERVER_BIN`, or as `channelstack` on the `PATH`: install it with `npm i -g channelstack`, or download it from the [GitHub releases](https://github.com/christian-bromann/channelstack/releases).

## Example

```rust
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
```

## Links

- [Documentation](https://channelstack.dev/docs), and [the SDKs](https://channelstack.dev/docs/reference/sdks)
- [Source, issues and changelog](https://github.com/christian-bromann/channelstack)

MIT licensed.
