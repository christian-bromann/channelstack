use channelstack::{GitHubCheckRun, Handle, Result, expect};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_apps_check_run_and_its_buttons() -> Result<()> {
    let session = fixtures::session().await?;
    let github = session.github().await?;
    let ana = github.create_user().login("ana").await?;
    let repo = github
        .create_repo()
        .files("./fixtures/web")
        .collaborators(vec![&ana as &dyn Handle])
        .apps(vec![&github.app()])
        .await?;
    let pr = ana
        .open_pull_request(json!({
            "from": "fix-login",
            "changes": { "src/app.ts": "export const broken = ;\n" },
        }))
        .repo(&repo)
        .await?;
    // @show:start
    expect(&pr)
        .to_have_check_run("my-agent")
        .conclusion("action_required")
        .await?;
    // The Rust SDK returns the check runs as JSON: wrap them as handles to act on one.
    let runs = GitHubCheckRun::wrap_vec(github.ctx(), pr.check_runs().await?)?;
    let run = runs.first().expect("the App's check run");

    ana.request_action("autofix").check_run(run).await?;
    ana.rerun().check_run(run).await?;
    // @show:end
    session.close().await
}
