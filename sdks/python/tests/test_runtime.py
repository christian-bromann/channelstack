"""The Python SDK runtime's own tests, mirroring the TypeScript runtime's (`runtime.test.ts`)."""

import asyncio
import secrets

import httpx
import pytest

from channelstack.runtime import transport
from channelstack.runtime.credentials import credential
from channelstack.runtime.transport import ChannelstackError, Transport, on_refusal, unreported_refusals

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
