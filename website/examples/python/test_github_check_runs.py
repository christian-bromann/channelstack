from channelstack import GitHubFixture
from pytest_channelstack import expect


async def test_the_apps_check_run_and_its_buttons(github: GitHubFixture) -> None:
    ana = await github.create_user(login="ana")
    repo = await github.create_repo(files="./fixtures/web", collaborators=[ana], apps=[github.app])
    pr = await ana.open_pull_request(
        {"from": "fix-login", "changes": {"src/app.ts": "export const broken = ;\n"}}, repo=repo
    )
    # @show:start
    await expect(pr).to_have_check_run("my-agent", conclusion="action_required")
    run = (await pr.check_runs())[0]

    await ana.request_action("autofix", check_run=run)
    await ana.rerun(check_run=run)
    # @show:end
