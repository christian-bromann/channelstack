"""`expect(subject).to_…()`: the matchers of `channelstack/vitest`, for pytest.

    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("incident", re.I))
    await expect(channel).not_to_have_channel_message_from("my-agent")

Each check reads plain SDK methods, the way the TypeScript matchers do (`integrations/matchers-core`):

- A positive check polls until it holds, and fails after the timeout with what was there instead.
- A negative check (`not_to_…`) and one with an exact count wait until the agent has been quiet
  for the whole quiet window, and check once.
"""

import re
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, Protocol

from channelstack import ChannelstackError
from channelstack.runtime.client import quiet_of
from channelstack.runtime.duration import Duration
from channelstack.runtime.wait import WaitTimeoutError, from_matches, text_matches, until_quiet, wait_for

from .options import defaults

Text = str | re.Pattern[str]


class Author(Protocol):
    @property
    def id(self) -> str: ...
    @property
    def name(self) -> str: ...


AuthorRef = Author | str


def _name(author: AuthorRef) -> str:
    return author if isinstance(author, str) else author.name


def _show(text: Text) -> str:
    return repr(text) if isinstance(text, str) else f"/{text.pattern}/"


def _says(messages: Sequence[Any]) -> str:
    lines = [f"{message.author.name}: {message.text}" for message in messages]
    return "\n".join(f"  {line}" for line in lines) if lines else "  (nothing)"


def _from(author: AuthorRef, text: Text | None = None) -> Callable[[Any], bool]:
    return lambda message: from_matches(message.author, author) and text_matches(message.text, text)


async def _messages_of(subject: Any) -> list[Any]:
    """What was said in a subject: a thread's replies, or a conversation's transcript (a DM, threads included)."""
    if hasattr(subject, "replies"):
        return list(await subject.replies())
    if hasattr(subject, "transcript"):
        return list((await subject.transcript()).entries)
    raise TypeError("This check needs a thread or a conversation")


def _streaming(message: Any) -> str | None:
    """A message's stream state; a transcript entry says `streaming` instead. Here they read the same."""
    stream = getattr(message, "stream", None)
    return getattr(stream, "state", None) if stream is not None else getattr(message, "streaming", None)


def _calls_matching(operation: Text, calls: Sequence[Any]) -> list[Any]:
    return [
        call
        for call in calls
        if (call.operation == operation if isinstance(operation, str) else operation.search(call.operation))
    ]


class Expectation:
    """The checks on one subject: a thread, a conversation, a message, or a channel's fixture."""

    def __init__(self, subject: Any) -> None:
        self._subject = subject

    async def _still_open(self) -> list[str]:
        """What the agent left open in the subject's session, in words: it only adds to a failure's message."""
        try:
            return list((await quiet_of(self._subject._ctx)).open)
        except (ChannelstackError, AttributeError, RuntimeError):
            return []

    async def _settle[T](
        self,
        *,
        read: Callable[[], Awaitable[T]],
        holds: Callable[[T], bool],
        describe: Callable[[T], str],
        negate: bool,
        once_quiet: bool = False,
        timeout: Duration | None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Run a check the way its kind needs, and fail with what was expected and what was there."""
        timeout = defaults.timeout if timeout is None else timeout
        if once_quiet or negate:
            # The check watches for the whole quiet window: what arrives while it looks counts.
            await until_quiet(
                lambda: quiet_of(self._subject._ctx),
                timeout=timeout,
                quiet_for=defaults.quiet_for if quiet_for is None else quiet_for,
                watching=True,
            )
            value = await read()
        else:
            last: list[T] = []

            async def attempt() -> tuple[T] | None:
                current = await read()
                last[:] = [current]
                return (current,) if holds(current) else None

            try:
                value = (await wait_for("the condition", attempt, timeout=timeout))[0]
            except WaitTimeoutError:
                value = last[0] if last else await read()
        if holds(value) == negate:
            open_work = await self._still_open()
            leftover = f"\nStill open: {'; '.join(open_work)}" if open_work else ""
            raise AssertionError(f"{describe(value)}{leftover}")

    # Replies and messages

    async def _reply_from(
        self, author: AuthorRef, text: Text | None, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        wanted = f"{'no' if negate else 'a'} reply from {_name(author)}"
        wanted += "" if text is None else f" matching {_show(text)}"
        await self._settle(
            read=lambda: _messages_of(self._subject),
            holds=lambda messages: any(map(_from(author, text), messages)),
            describe=lambda messages: f"Expected {wanted}. The thread has:\n{_says(messages)}",
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_reply_from(
        self, author: AuthorRef, *, text: Text | None = None, timeout: Duration | None = None
    ) -> None:
        """The thread (or DM) has a reply from this author, matching `text` if given."""
        await self._reply_from(author, text, timeout, None, negate=False)

    async def not_to_have_reply_from(
        self,
        author: AuthorRef,
        *,
        text: Text | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Once the agent is quiet, the thread has no reply from this author (matching `text` if given)."""
        await self._reply_from(author, text, timeout, quiet_for, negate=True)

    async def _replies_from(
        self,
        author: AuthorRef,
        count: int,
        text: Text | None,
        timeout: Duration | None,
        quiet_for: Duration | None,
        negate: bool,
    ) -> None:
        async def read() -> list[Any]:
            return [message for message in await _messages_of(self._subject) if _from(author, text)(message)]

        noun = "reply" if count == 1 else "replies"
        await self._settle(
            read=read,
            holds=lambda replies: len(replies) == count,
            describe=lambda replies: (
                f"Expected {'not ' if negate else ''}exactly {count} {noun} from {_name(author)}, "
                f"found {len(replies)}:\n{_says(replies)}"
            ),
            negate=negate,
            once_quiet=True,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_replies_from(
        self,
        author: AuthorRef,
        *,
        count: int,
        text: Text | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Exactly `count` replies from this author, checked once the agent is quiet."""
        await self._replies_from(author, count, text, timeout, quiet_for, negate=False)

    async def not_to_have_replies_from(
        self,
        author: AuthorRef,
        *,
        count: int,
        text: Text | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Any number of replies from this author but `count`, checked once the agent is quiet."""
        await self._replies_from(author, count, text, timeout, quiet_for, negate=True)

    async def _channel_message_from(
        self, author: AuthorRef, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        async def read() -> list[Any]:
            return [message for message in await self._subject.messages() if _from(author)(message)]

        await self._settle(
            read=read,
            holds=lambda messages: len(messages) > 0,
            describe=lambda messages: (
                f"Expected no message from {_name(author)} in the channel itself, found:\n{_says(messages)}"
                if negate
                else f"Expected a message from {_name(author)} in the channel itself, found none"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_channel_message_from(self, author: AuthorRef, *, timeout: Duration | None = None) -> None:
        """A message from this author directly in the channel, outside any thread."""
        await self._channel_message_from(author, timeout, None, negate=False)

    async def not_to_have_channel_message_from(
        self, author: AuthorRef, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, no message from this author directly in the channel."""
        await self._channel_message_from(author, timeout, quiet_for, negate=True)

    async def _streaming_reply_from(
        self, author: AuthorRef | None, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        def streaming(message: Any) -> bool:
            return _streaming(message) == "open" and (author is None or from_matches(message.author, author))

        await self._settle(
            read=lambda: _messages_of(self._subject),
            holds=lambda messages: any(map(streaming, messages)),
            describe=lambda messages: (
                f"Expected {'no' if negate else 'a'} reply being streamed"
                f"{'' if author is None else f' by {_name(author)}'}. The thread has:\n{_says(messages)}"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_streaming_reply_from(
        self, author: AuthorRef | None = None, *, timeout: Duration | None = None
    ) -> None:
        """A reply (from this author, if given) is being streamed right now."""
        await self._streaming_reply_from(author, timeout, None, negate=False)

    async def not_to_have_streaming_reply_from(
        self, author: AuthorRef | None = None, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, no reply (from this author, if given) is being streamed."""
        await self._streaming_reply_from(author, timeout, quiet_for, negate=True)

    # Status

    async def _status(self, expected: str, timeout: Duration | None, quiet_for: Duration | None, negate: bool) -> None:
        await self._settle(
            read=self._subject.status,
            holds=lambda status: status.state == expected,
            describe=lambda status: (
                f"Expected the thread {'not ' if negate else ''}to be {expected}, it is {status.state}"
                f"{'' if not status.text else f' ({status.text!r})'}"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_status(self, expected: str, *, timeout: Duration | None = None) -> None:
        """The agent's state in this thread: `working`, `streaming`, `stopped` or `idle`."""
        await self._status(expected, timeout, None, negate=False)

    async def not_to_have_status(
        self, expected: str, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, its state in this thread is another one."""
        await self._status(expected, timeout, quiet_for, negate=True)

    async def _status_text(
        self, text: Text, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        await self._settle(
            read=self._subject.status,
            holds=lambda status: status.text is not None and text_matches(status.text, text),
            describe=lambda status: (
                f"Expected the status line {'not ' if negate else ''}to match {_show(text)}, "
                f"{'there is none' if status.text is None else f'it is {status.text!r}'}"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_status_text(self, text: Text, *, timeout: Duration | None = None) -> None:
        """The status line the agent set matches `text`."""
        await self._status_text(text, timeout, None, negate=False)

    async def not_to_have_status_text(
        self, text: Text, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, its status line doesn't match `text`."""
        await self._status_text(text, timeout, quiet_for, negate=True)

    # Reactions

    async def _reaction(
        self, emoji: str, by: AuthorRef | None, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        name = emoji.strip(":")

        def described(reactions: Sequence[Any]) -> str:
            there = "; ".join(
                f":{reaction.emoji}: by {', '.join(author.name for author in reaction.by)}" for reaction in reactions
            )
            wanted = f"{'no' if negate else 'a'} :{name}: reaction{'' if by is None else f' by {_name(by)}'}"
            return f"Expected {wanted}. Reactions there: {there or 'none'}"

        await self._settle(
            read=self._subject.reactions,
            holds=lambda reactions: any(
                reaction.emoji == name and (by is None or any(from_matches(author, by) for author in reaction.by))
                for reaction in reactions
            ),
            describe=described,
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_reaction(
        self, emoji: str, *, by: AuthorRef | None = None, timeout: Duration | None = None
    ) -> None:
        """The message has this reaction (by this author, if given)."""
        await self._reaction(emoji, by, timeout, None, negate=False)

    async def not_to_have_reaction(
        self,
        emoji: str,
        *,
        by: AuthorRef | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Once the agent is quiet, the message has no such reaction (by this author, if given)."""
        await self._reaction(emoji, by, timeout, quiet_for, negate=True)

    # The agent's API calls

    async def _received_call(
        self,
        operation: Text,
        error: str | None,
        times: int | None,
        timeout: Duration | None,
        quiet_for: Duration | None,
        negate: bool,
    ) -> None:
        async def read() -> list[Any]:
            calls = await (self._subject.calls(error=error) if error else self._subject.calls())
            return _calls_matching(operation, calls)

        def described(matching: Sequence[Any]) -> str:
            wanted = f"the agent {'not ' if negate else ''}to call {_show(operation)}"
            wanted += "" if error is None else f" with error {error}"
            wanted += "" if times is None else f" exactly {times} times"
            found = ", ".join(f"{call.operation} → {call.error}" if call.error else call.operation for call in matching)
            return f"Expected {wanted}, found {len(matching)}{f': {found}' if found else ''}"

        await self._settle(
            read=read,
            holds=lambda matching: len(matching) > 0 if times is None else len(matching) == times,
            describe=described,
            negate=negate,
            once_quiet=times is not None,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_received_call(
        self,
        operation: Text,
        *,
        error: str | None = None,
        times: int | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """The agent made this call (with this error, if given; exactly `times` times once quiet, if given)."""
        await self._received_call(operation, error, times, timeout, quiet_for, negate=False)

    async def not_to_have_received_call(
        self,
        operation: Text,
        *,
        error: str | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Once the agent is quiet, it made no such call (with this error, if given)."""
        await self._received_call(operation, error, None, timeout, quiet_for, negate=True)


def expect(subject: Any) -> Expectation:
    """The checks on a subject: `await expect(msg.thread).to_have_reply_from("my-agent")`."""
    return Expectation(subject)
