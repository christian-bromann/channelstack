"""The fake OpenAI against the official `openai` Python SDK (exit check 13.3).

Every turn kind on both endpoints, streamed and not, read through the SDK's own stream helpers;
every error turn raised as the SDK's own class with OpenAI's status, `type` and `code`; and the
SDK's retries: exactly 429 and 5xx, none with `x-should-retry: false`, after `retry-after-ms`.

The calls carry the test's session id in `x-channelstack-session`, a tag the fake attributes them
by, so no agent is involved: `scripts/accept.ts` runs this file with the rest of the pytest port.
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import anyio
import pytest
import pytest_asyncio
from openai import (
    APIStatusError,
    AsyncOpenAI,
    AuthenticationError,
    BadRequestError,
    ContentFilterFinishReasonError,
    InternalServerError,
    LengthFinishReasonError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
)
from openai.types.chat import ChatCompletion, ChatCompletionToolUnionParam
from openai.types.responses import Response, ToolParam

from channelstack import Channelstack, OpenAIFixture, OpenAIToolCallSpec, OpenAITurn, Session

ENDPOINTS = ["chat.completions", "responses"]
PROMPT = "what broke in the web deploy yesterday?"


@pytest_asyncio.fixture(loop_scope="session")
async def client(channelstack: Channelstack, channelstack_session: Session) -> AsyncIterator[AsyncOpenAI]:
    """An OpenAI client on the fake, the way an agent has one, whose calls the test's session claims by their tag."""
    env = await channelstack.env()
    async with AsyncOpenAI(
        base_url=str(env["OPENAI_BASE_URL"]),
        api_key=str(env["OPENAI_API_KEY"]),
        default_headers={"x-channelstack-session": channelstack_session.session_id},
    ) as openai_client:
        yield openai_client


@dataclass
class Seen:
    """What an answer says, the same way for both endpoints."""

    text: str = ""
    deltas: list[str] = field(default_factory=lambda: [])
    refusal: str | None = None
    tool_calls: list[tuple[str, str, str]] = field(default_factory=lambda: [])
    finish: str = ""
    reasoning: str = ""
    usage: tuple[int, int, int, int] = (-1, -1, -1, -1)


CHAT_TOOLS: list[ChatCompletionToolUnionParam] = [
    {"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}},
    {"type": "custom", "custom": {"name": "run_sql"}},
]
RESPONSES_TOOLS: list[ToolParam] = [
    {"type": "function", "name": "lookup", "parameters": {"type": "object"}, "strict": False},
    {"type": "custom", "name": "run_sql"},
]


def seen_of_completion(completion: ChatCompletion, deltas: list[str]) -> Seen:
    choice = completion.choices[0]
    message = choice.message
    usage = completion.usage
    seen = Seen(text=message.content or "", deltas=deltas, refusal=message.refusal, finish=choice.finish_reason)
    for call in message.tool_calls or []:
        if call.type == "function":
            seen.tool_calls.append(("function", call.function.name, call.function.arguments))
        else:
            seen.tool_calls.append(("custom", call.custom.name, call.custom.input))
    if usage is not None:
        reasoning = usage.completion_tokens_details.reasoning_tokens if usage.completion_tokens_details else None
        cached = usage.prompt_tokens_details.cached_tokens if usage.prompt_tokens_details else None
        seen.usage = (usage.prompt_tokens, usage.completion_tokens, reasoning or 0, cached or 0)
    return seen


def seen_of_response(response: Response, deltas: list[str]) -> Seen:
    reason = response.incomplete_details.reason if response.incomplete_details else None
    seen = Seen(deltas=deltas, finish=f"incomplete: {reason}" if response.status == "incomplete" else "completed")
    for item in response.output:
        if item.type == "message":
            for part in item.content:
                if part.type == "output_text":
                    seen.text += part.text
                else:
                    seen.refusal = part.refusal
        elif item.type == "function_call":
            seen.tool_calls.append(("function", item.name, item.arguments))
        elif item.type == "custom_tool_call":
            seen.tool_calls.append(("custom", item.name, item.input))
        elif item.type == "reasoning":
            seen.reasoning += "".join(part.text for part in item.summary)
    if response.usage is not None:
        usage = response.usage
        seen.usage = (
            usage.input_tokens,
            usage.output_tokens,
            usage.output_tokens_details.reasoning_tokens,
            usage.input_tokens_details.cached_tokens,
        )
    return seen


async def raw_chat_stream(client: AsyncOpenAI, messages: list[Any]) -> Seen:
    """A Chat Completions stream read chunk by chunk, the way an agent without the stream helper reads it.

    The Python SDK's stream helper can't put a streamed custom tool call together (it reads only
    `function` deltas), so that turn is read from the raw chunks.
    """
    seen = Seen()
    calls: dict[int, list[str]] = {}
    chunks = await client.chat.completions.create(
        model="gpt-5", messages=messages, tools=CHAT_TOOLS, stream=True, stream_options={"include_usage": True}
    )
    async for chunk in chunks:
        if chunk.usage is not None:
            seen.usage = (chunk.usage.prompt_tokens, chunk.usage.completion_tokens, 0, 0)
        for choice in chunk.choices:
            if choice.delta.content:
                seen.deltas.append(choice.delta.content)
                seen.text += choice.delta.content
            for call in choice.delta.tool_calls or []:
                delta: dict[str, Any] = call.model_dump()
                kept = calls.setdefault(call.index, [delta.get("type") or "", "", ""])
                body: dict[str, Any] = delta.get("custom") or delta.get("function") or {}
                kept[1] += body.get("name") or ""
                kept[2] += body.get("input") or body.get("arguments") or ""
            if choice.finish_reason:
                seen.finish = choice.finish_reason
    seen.tool_calls = [(kind, name, value) for kind, name, value in (calls[index] for index in sorted(calls))]
    return seen


async def answer_on(client: AsyncOpenAI, endpoint: str, stream: bool, raw: bool = False) -> Seen:
    """Ask the way an agent does, through the SDK's own stream helpers when streamed, and read the answer."""
    deltas: list[str] = []
    if endpoint == "chat.completions":
        messages: list[Any] = [{"role": "user", "content": PROMPT}]
        if stream and raw:
            return await raw_chat_stream(client, messages)
        if not stream:
            return seen_of_completion(
                await client.chat.completions.create(model="gpt-5", messages=messages, tools=CHAT_TOOLS), deltas
            )
        try:
            async with client.chat.completions.stream(
                model="gpt-5", messages=messages, tools=CHAT_TOOLS, stream_options={"include_usage": True}
            ) as chat_stream:
                async for event in chat_stream:
                    if event.type == "content.delta" and event.delta:
                        deltas.append(event.delta)
                return seen_of_completion(await chat_stream.get_final_completion(), deltas)
        # The stream helper raises on these finishes, with the completion it put together.
        except (LengthFinishReasonError, ContentFilterFinishReasonError) as unfinished:
            assert unfinished.completion is not None
            return seen_of_completion(unfinished.completion, deltas)
    if not stream:
        return seen_of_response(
            await client.responses.create(
                model="gpt-5", input=PROMPT, tools=RESPONSES_TOOLS, reasoning={"summary": "auto"}
            ),
            deltas,
        )
    async with client.responses.stream(
        model="gpt-5", input=PROMPT, tools=RESPONSES_TOOLS, reasoning={"summary": "auto"}
    ) as responses_stream:
        incomplete: Response | None = None
        async for event in responses_stream:
            if event.type == "response.output_text.delta":
                deltas.append(event.delta)
            elif event.type == "response.incomplete":
                incomplete = event.response
        # The helper's final response is a completed one's: an incomplete one ends with its own event.
        if incomplete is not None:
            return seen_of_response(incomplete, deltas)
        return seen_of_response(await responses_stream.get_final_response(), deltas)


# Every turn kind: the turn, what both endpoints make of it, and what each makes of it alone.
TURN_KINDS: list[tuple[str, OpenAITurn, dict[str, Any], dict[str, dict[str, Any]]]] = [
    (
        "text",
        OpenAITurn(text="Two incidents."),
        {"text": "Two incidents.", "refusal": None, "tool_calls": []},
        {"chat.completions": {"finish": "stop"}, "responses": {"finish": "completed"}},
    ),
    (
        "chunks",
        OpenAITurn(text=["Two", " incidents", "."]),
        {"text": "Two incidents."},
        {"chat.completions": {"finish": "stop"}, "responses": {"finish": "completed"}},
    ),
    (
        "a function call",
        OpenAITurn(tool_calls=[OpenAIToolCallSpec(name="lookup", arguments={"query": "web deploy"})]),
        {"tool_calls": [("function", "lookup", '{"query":"web deploy"}')]},
        {"chat.completions": {"finish": "tool_calls"}, "responses": {"finish": "completed"}},
    ),
    (
        "a custom tool call",
        OpenAITurn(tool_calls=[OpenAIToolCallSpec(name="run_sql", input="SELECT count(*) FROM incidents")]),
        {"tool_calls": [("custom", "run_sql", "SELECT count(*) FROM incidents")]},
        {"chat.completions": {"finish": "tool_calls"}, "responses": {"finish": "completed"}},
    ),
    (
        "reasoning",
        OpenAITurn(reasoning={"summary": "Reading the incident log.", "tokens": 12}, text="Two incidents."),
        {"text": "Two incidents."},
        # OpenAI sends no reasoning summary on Chat Completions: only its token count.
        {"chat.completions": {"reasoning": ""}, "responses": {"reasoning": "Reading the incident log."}},
    ),
    (
        "a refusal",
        OpenAITurn(refusal="I can't help with that."),
        {"text": "", "refusal": "I can't help with that."},
        {"chat.completions": {"finish": "stop"}, "responses": {"finish": "completed"}},
    ),
    (
        "finish: length",
        OpenAITurn(text="Two inc", finish="length"),
        {"text": "Two inc"},
        {"chat.completions": {"finish": "length"}, "responses": {"finish": "incomplete: max_output_tokens"}},
    ),
    (
        "finish: content_filter",
        OpenAITurn(text="", finish="content_filter"),
        {"text": ""},
        {"chat.completions": {"finish": "content_filter"}, "responses": {"finish": "incomplete: content_filter"}},
    ),
    (
        "usage",
        OpenAITurn(text="ok", usage={"input": 100, "output": 20, "reasoning": 5, "cached": 40}),
        {"text": "ok", "usage": (100, 20, 5, 40)},
        {"chat.completions": {}, "responses": {}},
    ),
]


@pytest.mark.parametrize("stream", [False, True], ids=["whole", "streamed"])
@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize(("kind", "turn", "both", "each"), TURN_KINDS, ids=[kind for kind, *_ in TURN_KINDS])
async def test_every_turn_kind_as_the_official_sdk_parses_it(
    client: AsyncOpenAI,
    openai: OpenAIFixture,
    endpoint: str,
    stream: bool,
    kind: str,
    turn: OpenAITurn,
    both: dict[str, Any],
    each: dict[str, dict[str, Any]],
) -> None:
    await openai.respond(turn)

    answer = await answer_on(client, endpoint, stream, raw=kind == "a custom tool call")

    for name, expected in {**both, **each[endpoint]}.items():
        assert getattr(answer, name) == expected, f"{kind}: {name}"
    assert answer.usage[0] > 0
    if kind == "reasoning":
        assert answer.usage[2] == 12
    if stream:
        assert "".join(answer.deltas) == answer.text
        if isinstance(turn.text, list):
            assert answer.deltas == turn.text


async def call_on(client: AsyncOpenAI, endpoint: str, stream: bool) -> None:
    if endpoint == "chat.completions":
        await client.chat.completions.create(
            model="gpt-5", messages=[{"role": "user", "content": PROMPT}], stream=stream
        )
    else:
        await client.responses.create(model="gpt-5", input=PROMPT, stream=stream)


# Every error turn: the SDK's class, OpenAI's status, `type` and `code`, and whether the SDK retries it.
ERROR_TURNS: list[tuple[Any, type[APIStatusError], int, str, str | None, bool]] = [
    ("rate_limit", RateLimitError, 429, "requests", "rate_limit_exceeded", True),
    ("slow_down", RateLimitError, 429, "rate_limit_error", "slow_down", True),
    ("insufficient_quota", RateLimitError, 429, "insufficient_quota", "insufficient_quota", True),
    ("credit_balance_exhausted", RateLimitError, 429, "insufficient_quota", "credit_balance_exhausted", True),
    (
        "organization_spend_limit_exceeded",
        RateLimitError,
        429,
        "insufficient_quota",
        "organization_spend_limit_exceeded",
        True,
    ),
    ("project_spend_limit_exceeded", RateLimitError, 429, "insufficient_quota", "project_spend_limit_exceeded", True),
    (
        "organization_usage_limit_exceeded",
        RateLimitError,
        429,
        "insufficient_quota",
        "organization_usage_limit_exceeded",
        True,
    ),
    ("server_error", InternalServerError, 500, "server_error", None, True),
    ("overloaded", InternalServerError, 503, "service_unavailable_error", "server_is_overloaded", True),
    ("context_length_exceeded", BadRequestError, 400, "invalid_request_error", "context_length_exceeded", False),
    ("content_policy", BadRequestError, 400, "invalid_request_error", "invalid_prompt", False),
    ("invalid_api_key", AuthenticationError, 401, "invalid_request_error", "invalid_api_key", False),
    ("not_in_organization", AuthenticationError, 401, "invalid_request_error", "no_organization", False),
    ("ip_not_authorized", AuthenticationError, 401, "invalid_request_error", "ip_not_authorized", False),
    (
        "unsupported_region",
        PermissionDeniedError,
        403,
        "request_forbidden",
        "unsupported_country_region_territory",
        False,
    ),
]


@pytest.mark.parametrize("stream", [False, True], ids=["whole", "streamed"])
@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize(
    ("kind", "error_class", "status", "error_type", "code", "retried"),
    ERROR_TURNS,
    ids=[str(kind) for kind, *_ in ERROR_TURNS],
)
async def test_every_error_turn_raises_the_sdks_own_class_and_is_retried_only_when_it_should(
    client: AsyncOpenAI,
    openai: OpenAIFixture,
    endpoint: str,
    stream: bool,
    kind: Any,
    error_class: type[APIStatusError],
    status: int,
    error_type: str,
    code: str | None,
    retried: bool,
) -> None:
    # A millisecond's `retry-after-ms`: the Python SDK backs off on its own clock for a 0.
    await openai.respond(OpenAITurn(error=kind, retry_after=1), times=-1)

    with pytest.raises(error_class) as raised:
        await call_on(client, endpoint, stream)

    assert raised.value.status_code == status
    assert raised.value.type == error_type
    assert raised.value.code == code
    # The SDK's default two retries, or none.
    assert len(await openai.calls()) == (3 if retried else 1)


async def test_x_should_retry_false_stops_the_retry_of_a_503(client: AsyncOpenAI, openai: OpenAIFixture) -> None:
    await openai.respond(OpenAITurn(error="overloaded", should_retry=False), times=-1)

    with pytest.raises(InternalServerError):
        await call_on(client, "responses", False)

    assert len(await openai.calls()) == 1


async def test_the_sdk_waits_what_retry_after_ms_says_before_it_retries(
    client: AsyncOpenAI, openai: OpenAIFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    await openai.respond([OpenAITurn(error="overloaded", retry_after=1200), "All good now."])
    waits: list[float] = []
    sleep = anyio.sleep

    async def record(seconds: float) -> None:
        waits.append(seconds)
        await sleep(0)

    # The async client waits with `anyio.sleep`: what it asks for is what the test checks, without the wait.
    monkeypatch.setattr(anyio, "sleep", record)

    answer = await client.chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": PROMPT}])

    assert answer.choices[0].message.content == "All good now."
    # 1.2 seconds, from retry-after-ms: not retry-after's whole 2 seconds, nor the SDK's own backoff.
    assert waits == [1.2]


async def test_a_stored_response_is_retrieved_lists_its_input_and_is_deleted(
    client: AsyncOpenAI, openai: OpenAIFixture
) -> None:
    await openai.respond("Two incidents.")

    created = await client.responses.create(model="gpt-5", input=PROMPT)
    retrieved = await client.responses.retrieve(created.id)
    items = await client.responses.input_items.list(created.id)
    await client.responses.delete(created.id)

    assert retrieved.output_text == "Two incidents."
    assert [item.type for item in items.data] == ["message"]
    with pytest.raises(NotFoundError):
        await client.responses.retrieve(created.id)
