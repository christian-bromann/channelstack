"""Responders and model problems from pytest (exit checks 13.4 and 13.6).

A responder answers from the request and its context, and `first_token` holds while it is slow. A
model problem (no script, a list that ran out, a responder that raises or never answers, a turn
the real API can't give) fails the test: at once in a waiting check, and when the session closes
in a test that asserts nothing. The tests play the agent's model calls themselves, so no agent is
involved: `scripts/accept.ts` runs this file with the rest of the pytest port.
"""

import asyncio
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from channelstack import Channelstack, OpenAIFixture, OpenAIRequest, OpenAITiming, Session, SlackFixture
from pytest_channelstack import expect

ROOT = Path(__file__).resolve().parents[3]
STAND_INS = ROOT / "test/acceptance/stand-ins/openai-no-script/model_problems.py"


async def call_model(channelstack: Channelstack, text: str, *, user: str | None = None) -> tuple[int, Any, float]:
    """A Chat Completions call as an agent makes one: its status, its body, and how many seconds it took."""
    env = await channelstack.env()
    body: dict[str, Any] = {"model": "gpt-5", "messages": [{"role": "user", "content": text}]}
    if user is not None:
        body["user"] = user
    started = time.monotonic()
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{env['OPENAI_BASE_URL']}/chat/completions",
            headers={"authorization": f"Bearer {env['OPENAI_API_KEY']}"},
            json=body,
        )
    return response.status_code, response.json(), time.monotonic() - started


def content(body: Any) -> str:
    return str(body["choices"][0]["message"]["content"])


async def test_a_responder_answers_from_the_request_and_its_context(
    channelstack: Channelstack, slack: SlackFixture, openai: OpenAIFixture
) -> None:
    ana = await slack.create_user(name="Ana")
    ben = await slack.create_user(name="Ben")
    await ana.say("the web deploy is red again", to=slack.app)
    await ben.say("the nightly migration never finished", to=slack.app)

    def answer(request: OpenAIRequest) -> str:
        sender = request.context.from_
        who = "Ana" if sender and sender.id == ana.id else "Ben" if sender and sender.id == ben.id else "Nobody"
        return f"{who} asked in {request.context.channel}: {request.last_user_text}"

    ai = await openai.respond(answer)

    # No tag: the text the agent was sent is what gives the call, and its context, to this test.
    _, for_ana, _ = await call_model(channelstack, "Ana wrote: the web deploy is red again")
    _, for_ben, _ = await call_model(channelstack, "Ben wrote: the nightly migration never finished")

    assert content(for_ana) == "Ana asked in slack: Ana wrote: the web deploy is red again", for_ana
    assert content(for_ben) == "Ben asked in slack: Ben wrote: the nightly migration never finished", for_ben
    await expect(ai).to_have_answered()
    senders = [call.request.context.from_ for call in await ai.calls()]
    assert [sender.id if sender else None for sender in senders] == [ana.id, ben.id]


async def test_first_token_holds_with_a_slow_responder_it_counts_from_the_calls_arrival(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    async def slow(_: OpenAIRequest) -> str:
        await asyncio.sleep(0.8)
        return "Two incidents yesterday."

    await openai.respond(slow, timing=OpenAITiming(first_token=1500))

    status, body, seconds = await call_model(
        channelstack, "what broke yesterday?", user=channelstack_session.session_id
    )

    assert status == 200, body
    assert content(body) == "Two incidents yesterday."
    # Not before first_token, and the responder's time is part of it, not added to it.
    assert 1.5 <= seconds < 2.0, seconds


async def test_a_responder_slower_than_first_token_delays_the_answer_by_its_own_time_only(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    async def slower(_: OpenAIRequest) -> str:
        await asyncio.sleep(1.5)
        return "Still looking."

    await openai.respond(slower, timing=OpenAITiming(first_token=800))

    status, body, seconds = await call_model(channelstack, "anything new?", user=channelstack_session.session_id)

    assert status == 200, body
    assert content(body) == "Still looking."
    assert 1.5 <= seconds < 2.0, seconds


def _block(output: str, name: str, when: str) -> str:
    """What pytest printed for one test's failure (`when` "call") or its teardown's error ("teardown")."""
    title = name if when == "call" else f"ERROR at teardown of {name}"
    match = re.search(rf"^_+ {re.escape(title)} _+\n(.*?)(?=\n_+ |\n=+ )", output, re.S | re.M)
    assert match is not None, f"no {when} failure printed for {name}:\n{output}"
    return match.group(1)


async def test_every_model_problem_fails_the_test_at_once_or_when_its_session_closes_with_why() -> None:
    """The stand-ins run in their own pytest, against the same server, and must all fail. A waiting check's
    test fails, and its session's close says so again (the 4 failed and 4 of the 9 errors)."""
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "pytest",
        str(STAND_INS),
        "-c",
        str(ROOT / "test/acceptance/pytest/pytest.ini"),
        "-p",
        "no:cacheprovider",
        "--tb=short",
        cwd=ROOT,
        env={**os.environ, "NO_COLOR": "1"},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await process.communicate()
    output = stdout.decode()
    assert process.returncode == 1, output
    assert re.search(r"4 failed, 5 passed, 9 errors", output), output

    at_once = {
        "test_an_unscripted_call_fails_a_waiting_check_at_once": "no openai.respond(…) in this test answers this call",
        "test_a_list_that_runs_out_fails_a_waiting_check_at_once": "has 1 turn; call 2 arrived",
        "test_a_responder_that_raises_fails_a_waiting_check_at_once": "LookupError: no incident data in this fixture",
        "test_a_script_problem_fails_a_waiting_check_at_once": (
            "called `search_incidents`, but the request offered `lookup_runbook`"
        ),
    }
    for name, reason in at_once.items():
        failure = _block(output, name, "call")
        assert "The model calls of this test went wrong" in failure, failure
        assert reason in failure, failure
        gave_up = re.search(r"the check gave up after (\d+)ms", failure)
        assert gave_up is not None, failure
        # The check polls the session's problems: it stops within a second, not at its timeout.
        assert int(gave_up.group(1)) < 1000, failure

    at_close = {
        "test_an_unscripted_call_fails_a_test_that_asserts_nothing": "no openai.respond(…) in this test answers",
        "test_a_list_that_runs_out_fails_a_test_that_asserts_nothing": "has 1 turn; call 2 arrived",
        "test_a_responder_that_raises_fails_a_test_that_asserts_nothing": "LookupError: no incident data",
        "test_a_script_problem_fails_a_test_that_asserts_nothing": "called `search_incidents`, but the request",
        "test_a_responder_that_never_answers_fails_the_test_with_its_reason": "the test didn't answer the model call",
    }
    for name, reason in at_close.items():
        error = _block(output, name, "teardown")
        assert re.search(r"The model calls of this test went wrong:\n {2}\S", error), error
        assert reason in error, error
