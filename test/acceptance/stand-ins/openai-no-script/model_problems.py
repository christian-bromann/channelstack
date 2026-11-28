"""Tests that must fail (exit check 13.4), the pytest port of `fails.ts`.

`test/acceptance/pytest/test_openai_responders.py` runs this file in its own pytest and expects
every test to fail with why: each plays an agent whose model call no script can answer. A waiting
check fails at once instead of timing out; a test that asserts nothing fails when its session closes.
"""

import asyncio
import time
from collections.abc import Awaitable
from typing import Any

import httpx

from channelstack import (
    Channelstack,
    OpenAIFixture,
    OpenAIMatch,
    OpenAIToolCallSpec,
    OpenAITurn,
    Session,
)
from pytest_channelstack import expect

NEVER_SENT = "words this agent never sends to the model"
"""What no call here ever sends: a check on it waits until its timeout, unless a model problem stops it."""


async def call_model(
    channelstack: Channelstack, session: Session, text: str, tools: tuple[str, ...] = ()
) -> httpx.Response:
    """A Chat Completions call as an agent makes one, tagged with the test's session (`user`)."""
    env = await channelstack.env()
    body: dict[str, Any] = {
        "model": "gpt-5",
        "user": session.session_id,
        "messages": [{"role": "user", "content": text}],
    }
    if tools:
        body["tools"] = [
            {
                "type": "function",
                "function": {"name": name, "parameters": {"type": "object"}},
            }
            for name in tools
        ]
    async with httpx.AsyncClient(timeout=30) as client:
        return await client.post(
            f"{env['OPENAI_BASE_URL']}/chat/completions",
            headers={"authorization": f"Bearer {env['OPENAI_API_KEY']}"},
            json=body,
        )


async def timed(check: Awaitable[None]) -> None:
    """A check that must fail on a model problem: fail with its message and how long it took."""
    started = time.monotonic()
    try:
        await check
    except AssertionError as error:
        raise AssertionError(
            f"{error}\n(the check gave up after {round((time.monotonic() - started) * 1000)}ms)"
        ) from None
    raise AssertionError("the check passed")


async def test_an_unscripted_call_fails_a_waiting_check_at_once(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    ai = await openai.respond("never used", when=OpenAIMatch(text="something else entirely"))
    assert (await call_model(channelstack, channelstack_session, "what broke yesterday?")).status_code == 400
    await timed(expect(ai).to_have_answered(timeout="20s"))


async def test_an_unscripted_call_fails_a_test_that_asserts_nothing(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    await call_model(channelstack, channelstack_session, "what broke yesterday?")


async def test_a_list_that_runs_out_fails_a_waiting_check_at_once(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    await openai.respond(["The only answer."])
    assert (await call_model(channelstack, channelstack_session, "what broke yesterday?")).status_code == 200
    assert (await call_model(channelstack, channelstack_session, "and the day before?")).status_code == 400
    await timed(expect(openai).to_have_sent(NEVER_SENT, timeout="20s"))


async def test_a_list_that_runs_out_fails_a_test_that_asserts_nothing(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    await openai.respond(["The only answer."])
    await call_model(channelstack, channelstack_session, "what broke yesterday?")
    await call_model(channelstack, channelstack_session, "and the day before?")


def no_data(_: Any) -> str:
    raise LookupError("no incident data in this fixture")


async def test_a_responder_that_raises_fails_a_waiting_check_at_once(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    await openai.respond(no_data)
    assert (await call_model(channelstack, channelstack_session, "what broke yesterday?")).status_code == 400
    await timed(expect(openai).to_have_sent(NEVER_SENT, timeout="20s"))


async def test_a_responder_that_raises_fails_a_test_that_asserts_nothing(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    await openai.respond(no_data)
    await call_model(channelstack, channelstack_session, "what broke yesterday?")


SEARCH = OpenAITurn(tool_calls=[OpenAIToolCallSpec(name="search_incidents", arguments={"since": "yesterday"})])
"""A turn that calls a tool the request below doesn't offer: what the real API can't answer."""


async def test_a_script_problem_fails_a_waiting_check_at_once(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    await openai.respond(SEARCH)
    answer = await call_model(
        channelstack,
        channelstack_session,
        "what broke yesterday?",
        tools=("lookup_runbook",),
    )
    assert answer.status_code == 400
    await timed(expect(openai).to_have_sent(NEVER_SENT, timeout="20s"))


async def test_a_script_problem_fails_a_test_that_asserts_nothing(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    await openai.respond(SEARCH)
    await call_model(
        channelstack,
        channelstack_session,
        "what broke yesterday?",
        tools=("lookup_runbook",),
    )


async def test_a_responder_that_never_answers_fails_the_test_with_its_reason(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    async def never(_: Any) -> str:
        await asyncio.Event().wait()
        return "unreachable"

    await openai.respond(never)
    # The server gives up on the test's answer after its 10s, and refuses the call.
    assert (await call_model(channelstack, channelstack_session, "what broke yesterday?")).status_code == 400
