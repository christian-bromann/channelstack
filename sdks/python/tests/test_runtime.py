"""The Python SDK runtime's own tests, mirroring the TypeScript runtime's (`runtime.test.ts`)."""

import asyncio
import base64
import inspect
import json
import secrets
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from channelstack import GoogleApp, GoogleUser, ResendThread, ResendUser, SlackDelivery, SlackThread
from channelstack.runtime import transport
from channelstack.runtime.client import HandleContext
from channelstack.runtime.credentials import credential
from channelstack.runtime.files import read_changes, read_document, read_tree, set_files_root
from channelstack.runtime.transport import ChannelstackError, Transport, on_refusal, unreported_refusals
from channelstack.runtime.wait import (
    QuietState,
    WaitTimeoutError,
    normalised_text,
    set_wait_defaults,
    until_quiet,
    wait_defaults,
)

TEMPLATE = "CHANNELSTACK_SLACK_USER_{name}_TOKEN"


def test_a_persons_token_comes_from_the_environment_by_the_name_the_test_gave(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CHANNELSTACK_SLACK_USER_ANA_SMITH_TOKEN", raising=False)
    assert credential(TEMPLATE, {"name": "Ana Smith"}) is None
    monkeypatch.setenv("CHANNELSTACK_SLACK_USER_ANA_SMITH_TOKEN", "xoxp-from-the-environment")
    assert credential(TEMPLATE, {"name": "Ana Smith"}) == "xoxp-from-the-environment"
    assert credential(TEMPLATE, {"name": "ana-smith"}) == "xoxp-from-the-environment"
    # Without the name there is nothing to look up, and an empty variable is no credential.
    assert credential(TEMPLATE, {"name": None}) is None
    monkeypatch.setenv("CHANNELSTACK_SLACK_USER_ANA_SMITH_TOKEN", "")
    assert credential(TEMPLATE, {"name": "Ana Smith"}) is None


def test_a_refusal_is_seen_before_it_is_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    refused = httpx.Response(
        501,
        json={"error": "unsupported_in_live", "message": "SlackDelivery.retry isn't supported live", "data": {}},
    )

    async def send(*_: object) -> httpx.Response:
        return refused

    seen: list[str] = []
    client = Transport(url="http://127.0.0.1:1", token=secrets.token_hex(8), base_path="/_channelstack", errors={})
    monkeypatch.setattr(client, "_send", send)
    on_refusal(lambda error, path: seen.append(f"{error.code} {path}"))
    try:
        with pytest.raises(ChannelstackError) as raised:
            asyncio.run(client.request("POST", "/x"))
    finally:
        on_refusal(None)
    assert raised.value.code == "unsupported_in_live"
    assert seen == ["unsupported_in_live /x"]
    assert transport._refusal_handler is None  # pyright: ignore[reportPrivateUsage]


def test_an_unreported_read_keeps_its_refusal_to_itself(monkeypatch: pytest.MonkeyPatch) -> None:
    async def send(*_: object) -> httpx.Response:
        return httpx.Response(501, json={"error": "action_requires", "message": "needs the browser", "data": {}})

    seen: list[str] = []
    client = Transport(url="http://127.0.0.1:1", token=secrets.token_hex(8), base_path="/_channelstack", errors={})
    monkeypatch.setattr(client, "_send", send)
    on_refusal(lambda error, path: seen.append(f"{error.code} {path}"))
    try:
        with pytest.raises(ChannelstackError):
            asyncio.run(client.request("GET", "/sessions/s/quiet"))
        with pytest.raises(ChannelstackError, match="needs the browser"):
            asyncio.run(unreported_refusals(lambda: client.request("GET", "/sessions/s/quiet")))
    finally:
        on_refusal(None)
    assert seen == ["action_requires /sessions/s/quiet"]


def test_the_wait_defaults_a_test_framework_sets_apply_to_every_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    # The generated waits take their defaults from the runtime, not from their own signatures.
    for method in (SlackThread.wait_for_reply, SlackThread.latest_reply, SlackDelivery.settled):
        assert inspect.signature(method).parameters["timeout"].default is None
    assert inspect.signature(SlackThread.latest_reply).parameters["quiet_for"].default is None

    async def send(*_: object) -> httpx.Response:
        return httpx.Response(200, json=[])

    client = Transport(url="http://127.0.0.1:1", token=secrets.token_hex(8), base_path="/_channelstack", errors={})
    monkeypatch.setattr(client, "_send", send)
    thread = SlackThread(
        HandleContext(transport=client, session="ses_1"),
        {"channel": "C01", "ts": "1.1", "conversation": {"id": "C01", "kind": "channel"}},
    )
    before = wait_defaults()
    assert (before.timeout, before.quiet_for) == ("10s", "750ms")
    set_wait_defaults(timeout="40ms", quiet_for="30ms")
    try:
        with pytest.raises(WaitTimeoutError, match="Timed out after 40ms waiting for a reply"):
            asyncio.run(thread.wait_for_reply())

        async def quiet_for_ms(ms: float) -> QuietState:
            return QuietState(busy=False, quiet_for_ms=ms)

        asyncio.run(until_quiet(lambda: quiet_for_ms(30)))
        with pytest.raises(WaitTimeoutError, match="quiet for 30ms"):
            asyncio.run(until_quiet(lambda: quiet_for_ms(10)))
        # What a call gives still wins.
        asyncio.run(until_quiet(lambda: quiet_for_ms(10), quiet_for=5))
    finally:
        set_wait_defaults(timeout=before.timeout, quiet_for=before.quiet_for)


def email(channel: str, id: str, author: dict[str, str]) -> dict[str, object]:
    """An email as the server sends it: its author is plain data, not a handle."""
    return {
        "id": id,
        "channel": channel,
        "thread": {"id": "t1", "channel": channel, "subject": "Invoice"},
        "author": author,
        "from": f"{author['name']}@example.test",
        "to": [],
        "cc": [],
        "subject": "Invoice",
        "text": f"from {author['name']}",
        "at": "2026-01-01T00:00:00Z",
        "messageId": f"<{id}@example.test>",
        # Every header the sender set, by lower-case name (decision 0027).
        "headers": {},
        "labels": [],
    }


def test_an_email_wait_takes_the_channels_own_handles_as_who_it_is_from(monkeypatch: pytest.MonkeyPatch) -> None:
    # Python checks types by name, so the waits name the handles as well as the email's author data:
    # `from_=google.app` type-checks, as `from: google.app` does in TypeScript.
    agent = {"id": "app_1", "name": "my-agent", "kind": "app"}
    ben = {"id": "user_2", "name": "Ben", "kind": "user"}

    async def send(*_: object) -> httpx.Response:
        return httpx.Response(200, json=[email("google", "e1", ben), email("google", "e2", agent)])

    client = Transport(url="http://127.0.0.1:1", token=secrets.token_hex(8), base_path="/_channelstack", errors={})
    monkeypatch.setattr(client, "_send", send)
    ctx = HandleContext(transport=client, session="ses_1")
    person = {"channel": "google", "kind": "user", "address": "x@example.test"}
    # The app's handle carries its own mailbox's credentials (decision 0027).
    credentials = {"clientId": "c1", "clientSecret": "s1", "refreshToken": "r1"}
    app = GoogleApp(
        ctx, {**agent, "channel": "google", "botUserId": "b1", "address": "agent@example.test", **credentials}
    )
    ana = GoogleUser(ctx, {**person, "id": "user_1", "name": "Ana"})
    assert asyncio.run(ana.wait_for_email(from_=app, timeout="40ms")).id == "e2"

    async def send_resend(*_: object) -> httpx.Response:
        return httpx.Response(200, json=[email("resend", "e3", agent), email("resend", "e4", ben)])

    monkeypatch.setattr(client, "_send", send_resend)
    thread = ResendThread(ctx, {"id": "t1", "channel": "resend", "subject": "Invoice"})
    resend_ben = ResendUser(ctx, {**person, **ben, "channel": "resend"})
    assert asyncio.run(thread.wait_for_reply(from_=resend_ben, timeout="40ms")).id == "e4"


# Files a test hands over (`files.py`), as the TypeScript runtime's "files a test hands over".


@pytest.fixture
def fixture(tmp_path: Path) -> Iterator[Path]:
    """A fixture directory `web` with a file at its top and one in a subdirectory. Leaves no root set."""
    (tmp_path / "web" / "src").mkdir(parents=True)
    (tmp_path / "web" / "README.md").write_text("# web\n")
    (tmp_path / "web" / "src" / "app.ts").write_text("export {}\n")
    yield tmp_path
    set_files_root(None)


def text(content: str | None) -> str | None:
    return None if content is None else base64.b64decode(content).decode()


def test_a_document_is_its_text_inline_or_a_fixture_files_contents_from_the_tests_directory(fixture: Path) -> None:
    set_files_root(fixture)
    assert read_document("# inline") == "# inline"
    assert read_document({"path": "./web/README.md"}) == "# web\n"
    blocks: list[dict[str, object]] = [{"type": "divider", "divider": {}}]
    assert read_document(blocks) is blocks


def test_a_directory_is_every_file_under_it_by_its_path_inside_it(fixture: Path) -> None:
    assert [(file["path"], text(file["content"])) for file in read_tree(str(fixture / "web"))] == [
        ("README.md", "# web\n"),
        ("src/app.ts", "export {}\n"),
    ]


def test_a_relative_path_starts_from_the_root_an_integration_set_or_from_the_working_directory(
    fixture: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_files_root(fixture)
    assert [file["path"] for file in read_tree("./web")] == ["README.md", "src/app.ts"]
    assert [file["path"] for file in read_tree([{"path": "web/README.md"}])] == ["README.md"]
    set_files_root(None)
    # Without a root the same path starts from the working directory, where it isn't: an error, not no files.
    (fixture / "elsewhere").mkdir()
    monkeypatch.chdir(fixture / "elsewhere")
    with pytest.raises(FileNotFoundError):
        read_tree("./web")
    monkeypatch.chdir(fixture)
    assert [file["path"] for file in read_tree("./web")] == ["README.md", "src/app.ts"]
    with pytest.raises(NotADirectoryError):
        read_tree("./web/README.md")


def test_a_list_takes_inline_contents_a_file_on_disk_under_a_name_and_a_directory_under_a_prefix(
    fixture: Path,
) -> None:
    files = read_tree(
        [
            {"name": "notes.txt", "content": "hi"},
            {"name": "bin/data", "content": bytes([0, 255])},
            {"path": str(fixture / "web" / "README.md")},
            {"path": str(fixture / "web" / "README.md"), "name": "docs/README.md"},
            {"path": str(fixture / "web" / "src"), "name": "lib"},
        ]
    )
    assert [file["path"] for file in files] == ["notes.txt", "bin/data", "README.md", "docs/README.md", "lib/app.ts"]
    assert text(files[0]["content"]) == "hi"
    assert base64.b64decode(files[1]["content"]) == bytes([0, 255])
    assert text(files[3]["content"]) == "# web\n"


def test_changes_are_a_list_of_files_or_a_map_of_path_to_contents_where_none_deletes(fixture: Path) -> None:
    changes = read_changes({"src/app.ts": "export const x = 1\n", "old.ts": None})
    assert [(file["path"], text(file["content"])) for file in changes] == [
        ("src/app.ts", "export const x = 1\n"),
        ("old.ts", None),
    ]
    assert read_changes([{"name": "a.txt", "content": "a"}]) == [{"path": "a.txt", "content": "YQ=="}]
    assert [file["path"] for file in read_changes([{"path": str(fixture / "web"), "name": "site"}])] == [
        "site/README.md",
        "site/src/app.ts",
    ]


# The server's own cases (`server/src/core/attribution/attribution.test.ts` reads the same file).
NORMALISATION_CASES: list[dict[str, str]] = json.loads(
    (Path(__file__).resolve().parents[3] / "test" / "text-normalisation.json").read_text(encoding="utf-8")
)["cases"]


@pytest.mark.parametrize("case", NORMALISATION_CASES, ids=lambda case: case["text"] or "empty")
def test_the_generated_rules_normalise_text_as_the_server_does(case: dict[str, str]) -> None:
    assert normalised_text(case["text"]) == case["normalised"]
