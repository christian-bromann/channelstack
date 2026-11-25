from channelstack import GitHubFixture, NotionFixture


async def test_files_and_fixture_directories(github: GitHubFixture, notion: NotionFixture) -> None:
    ana = await github.create_user(login="ana")
    # @show:start
    repo = await github.create_repo(
        files="./fixtures/web",
        collaborators=[ana],
        apps=[github.app],
    )

    pr = await ana.open_pull_request(
        {
            "from": "fix-login",
            "title": "Fix login redirect",
            "changes": {"src/login.ts": "export const redirect = '/home';\n"},
        },
        repo=repo,
    )

    spec = await notion.create_page(
        title="Spec",
        content={"path": "./fixtures/spec.md"},
        connections=[notion.app],
    )
    # @show:end
    _ = (pr, spec)
