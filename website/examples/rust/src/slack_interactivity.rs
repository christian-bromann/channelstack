use channelstack::{Handle, Result, Regex};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn buttons_menus_modals_commands_and_shortcuts() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let ben = slack.create_user().name("Ben").admin(true).await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &ben, &slack.app()])
        .await?;
    let msg = ana.say("@my-agent deploy web").channel(&channel).await?;
    let report = ana
        .say("Checkout is down for some people")
        .channel(&channel)
        .await?;
    // @show:start
    let ask = msg.thread().latest_reply().from("my-agent").await?;
    ben.click("Approve").message(&ask).await?;

    ana.select("staging")
        .menu("Environment")
        .message(&ask)
        .await?;

    ana.click("Open form").thread(&msg.thread()).await?;
    let modal = ana
        .wait_for_modal()
        .title(Regex::new("(?i)incident")?)
        .await?;
    modal
        .submit(json!({ "Severity": "SEV2", "Summary": "Checkout errors" }))
        .await?;

    ana.run_command("/deploy web staging")
        .channel(&channel)
        .await?;
    ana.shortcut("create_ticket").message(&report).await?;
    // @show:end
    session.close().await
}
