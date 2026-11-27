"""`expect(subject).to_…()`: the matchers of `channelstack/vitest`, for pytest.

    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("incident", re.I))
    await expect(channel).not_to_have_channel_message_from("my-agent")

Each check reads plain SDK methods, the way the TypeScript matchers do (`integrations/matchers-core`):

- A positive check polls until it holds, and fails after the timeout with what was there instead.
- A negative check (`not_to_…`) and one with an exact count wait until the agent has been quiet
  for the whole quiet window, and check once.
"""

import json
import re
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, Protocol

from channelstack import ChannelstackError
from channelstack.runtime.client import quiet_of
from channelstack.runtime.duration import Duration, parse_duration
from channelstack.runtime.transport import unreported_refusals
from channelstack.runtime.wait import (
    WaitTimeoutError,
    from_matches,
    pattern_on_wire,
    text_matches,
    until_quiet,
    wait_for,
)

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
    """What was asked for, as matchers-core shows it: a string quoted, a pattern as `/source/flags`."""
    if isinstance(text, str):
        return json.dumps(text, ensure_ascii=False)
    wire = pattern_on_wire(text)
    return wire if isinstance(wire, str) else f"/{wire['source']}/{wire['flags']}"


def _named(name: str, expected: Text) -> bool:
    """A name asked for by a string must equal it; a pattern need only match."""
    return name == expected if isinstance(expected, str) else expected.search(name) is not None


def _number(value: float) -> str:
    """A number as JavaScript prints it: `3000`, not `3000.0`."""
    return str(int(value)) if float(value).is_integer() else str(value)


def _says(messages: Sequence[Any]) -> str:
    return _listing([f"{message.author.name}: {message.text}" for message in messages])


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


def _listing(lines: Sequence[str]) -> str:
    return "\n".join(f"  {line}" for line in lines) if lines else "  (nothing)"


def _comment_text(comment: Any) -> str:
    """GitHub and Linear call a comment's text `body`, Notion calls it `text`."""
    return str(getattr(comment, "body", None) or getattr(comment, "text", None) or "")


def _comment_from(author: AuthorRef, text: Text | None = None) -> Callable[[Any], bool]:
    return lambda comment: from_matches(comment.author, author) and text_matches(_comment_text(comment), text)


def _written(comments: Sequence[Any]) -> str:
    return _listing([f"{comment.author.name}: {_comment_text(comment)}" for comment in comments])


async def _comments_of(subject: Any, check: str) -> list[Any]:
    """The comments of a subject that has a conversation: a GitHub issue or pull request, a Linear issue, a Notion
    discussion. A Notion page has none of its own: they are in its discussions."""
    if hasattr(subject, "comments"):
        return list(await subject.comments())
    raise TypeError(
        f"{check} needs a Notion discussion, not a page: a page's comments are in its discussions. "
        "Pass `comment.discussion`, or one of `await page.discussions()`."
        if hasattr(subject, "discussions")
        else f"{check} needs a GitHub issue or pull request, a Linear issue or a Notion discussion"
    )


def _block_texts(blocks: Sequence[Any]) -> list[str]:
    """The text of each block of a Notion page, nested ones included: its rich text, or a child page's title."""
    texts: list[str] = []
    for block in blocks:
        kind = block.get("type")
        data: dict[str, Any] = (block.get(kind) if kind else None) or {}
        rich_text = data.get("rich_text")
        text = "".join(item.get("plain_text") or "" for item in rich_text) if rich_text else data.get("title") or ""
        texts += [str(text), *_block_texts(block.get("children") or [])]
    return texts


async def _session_of(subject: Any) -> Any | None:
    """A Linear agent session, or the latest one of an issue."""
    if hasattr(subject, "state") and hasattr(subject, "activities"):
        return subject
    if hasattr(subject, "sessions"):
        sessions = list(await subject.sessions())
        return sessions[-1] if sessions else None
    raise TypeError("This check needs an agent session or an issue")


async def _writers_of(subject: Any) -> list[tuple[str, bool]]:
    """Who wrote each message of a conversation, oldest first, and whether it was an app."""
    if hasattr(subject, "replies") or hasattr(subject, "transcript"):
        authors = [message.author for message in await _messages_of(subject)]
    elif hasattr(subject, "comments"):
        authors = [comment.author for comment in await subject.comments()]
    else:
        raise TypeError("to_go_quiet needs a thread, a conversation, or something with comments")
    return [(author.name, getattr(author, "kind", None) == "app") for author in authors]


class Expectation:
    """The checks on one subject: a thread, a conversation, a message, or a channel's fixture."""

    def __init__(self, subject: Any) -> None:
        self._subject = subject

    async def _still_open(self) -> list[str]:
        """What the agent left open in the subject's session, in words: it only adds to a failure's message.

        Its refusal goes nowhere else: live, a refused read here must not turn the failure into a skip.
        """
        try:
            return list((await unreported_refusals(lambda: quiet_of(self._subject._ctx))).open)
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
        if once_quiet or negate:
            # The check watches for the whole quiet window: what arrives while it looks counts.
            await until_quiet(
                lambda: quiet_of(self._subject._ctx),
                timeout=timeout,
                quiet_for=quiet_for,
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

    async def to_go_quiet(
        self, *, max_replies: int, within: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """The conversation goes quiet within `within`, with at most `max_replies` app messages since a person wrote.

        Those written before the check began count too: apps answering each other without end fail it (decision 0027).
        """
        quiet = True
        try:
            await until_quiet(lambda: quiet_of(self._subject._ctx), timeout=within, quiet_for=quiet_for, watching=True)
        except WaitTimeoutError:
            quiet = False
        writers = await _writers_of(self._subject)
        last_person = max((at for at, (_, app) in enumerate(writers) if not app), default=-1)
        since = writers[last_person + 1 :]
        if quiet and len(since) <= max_replies:
            return
        turns = f": {' → '.join(name for name, _ in since)}" if since else ""
        bound = f"within {within}" if within is not None else "within the timeout"
        open_work = await self._still_open()
        leftover = f"\nStill open: {'; '.join(open_work)}" if open_work else ""
        raise AssertionError(
            f"Expected the conversation to go quiet {bound} with at most {max_replies} app "
            f"{'message' if max_replies == 1 else 'messages'} since a person last wrote. "
            f"{'It went quiet' if quiet else 'It was still busy'} with {len(since)} app "
            f"{'message' if len(since) == 1 else 'messages'} and no person between them{turns}{leftover}"
        )

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
                f"{'' if author is None else f' by {_name(author)}'}. The thread has:\n"
                + _listing([f"{m.author.name}: {m.text} [{_streaming(m) or 'not a stream'}]" for m in messages])
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
                f"{'' if not status.text else f' ("{status.text}")'}"
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
                f"{'there is none' if status.text is None else f'it is "{status.text}"'}"
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
        async def read() -> tuple[list[Any], list[Any]]:
            calls = list(await (self._subject.calls(error=error) if error is not None else self._subject.calls()))
            return calls, [call for call in calls if _named(call.operation, operation)]

        def described(value: tuple[list[Any], list[Any]]) -> str:
            calls, matching = value
            wanted = f"the agent {'not ' if negate else ''}to call {_show(operation)}"
            wanted += "" if times is None else f" {times} times"
            wanted += "" if error is None else f" with error {error}"
            listed = _listing([f"{call.operation} → {call.error}" if call.error else call.operation for call in calls])
            return f"Expected {wanted}, found {len(matching)}. Its calls:\n{listed}"

        await self._settle(
            read=read,
            holds=lambda value: len(value[1]) > 0 if times is None else len(value[1]) == times,
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
        times: int | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Once the agent is quiet, it made no such call (with this error; any number but `times`, if given)."""
        await self._received_call(operation, error, times, timeout, quiet_for, negate=True)

    # What a person reads: text and buttons

    async def to_contain_text(
        self,
        text: Text,
        *,
        count: int | None = None,
        from_: AuthorRef | None = None,
        as_: Author | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Some entry a person would see contains this text. `count` makes it exact, checked once quiet.

        `as_` reads the transcript as that person or app sees it, their ephemeral messages included.
        """
        await self._contains_text(text, count, from_, as_, timeout, quiet_for, negate=False)

    async def not_to_contain_text(
        self,
        text: Text,
        *,
        count: int | None = None,
        from_: AuthorRef | None = None,
        as_: Author | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Once the agent is quiet, no entry a person would see contains this text (as `as_` sees it, if given).

        With `count`, any number of such entries but `count`.
        """
        await self._contains_text(text, count, from_, as_, timeout, quiet_for, negate=True)

    async def _contains_text(
        self,
        text: Text,
        count: int | None,
        from_: AuthorRef | None,
        as_: Author | None,
        timeout: Duration | None,
        quiet_for: Duration | None,
        negate: bool,
    ) -> None:
        async def read() -> tuple[list[Any], list[Any]]:
            # Only a subject that has viewers takes `as_`, as in matchers-core: pass it only when given.
            transcript = await (self._subject.transcript(as_=as_) if as_ is not None else self._subject.transcript())
            entries = [entry for entry in transcript.entries if from_ is None or from_matches(entry.author, from_)]
            return entries, [entry for entry in entries if text_matches(entry.text, text)]

        def described(value: tuple[list[Any], list[Any]]) -> str:
            entries, matching = value
            wanted = "no text" if negate else "text" if count is None else f"exactly {count} entries with text"
            return f"Expected {wanted} matching {_show(text)}, found {len(matching)}. A person sees:\n{_says(entries)}"

        await self._settle(
            read=read,
            holds=lambda value: len(value[1]) > 0 if count is None else len(value[1]) == count,
            describe=described,
            negate=negate,
            once_quiet=count is not None,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def _button(self, label: Text, timeout: Duration | None, quiet_for: Duration | None, negate: bool) -> None:
        async def read() -> list[str]:
            subject = self._subject
            # A message is one entry of its thread's transcript.
            if hasattr(subject, "thread") and hasattr(subject, "ts"):
                entries = (await subject.thread.transcript()).entries
                return [control for entry in entries if entry.id == subject.ts for control in entry.controls]
            entries = [entry for entry in (await subject.transcript()).entries if entry.author.kind == "app"]
            return list(entries[-1].controls) if entries else []

        await self._settle(
            read=read,
            holds=lambda controls: any(text_matches(control, label) for control in controls),
            describe=lambda controls: (
                f"Expected {'no' if negate else 'a'} button matching {_show(label)}. "
                f"Buttons there: {', '.join(controls) or 'none'}"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_button(self, label: Text, *, timeout: Duration | None = None) -> None:
        """A message (or the app's latest message in a thread or conversation) has a button with this label."""
        await self._button(label, timeout, None, negate=False)

    async def not_to_have_button(
        self, label: Text, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, the message (or the app's latest one) has no button with this label."""
        await self._button(label, timeout, quiet_for, negate=True)

    # Comments: GitHub issues and pull requests, Linear issues, Notion discussions

    async def _comment_from(
        self, author: AuthorRef, text: Text | None, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        wanted = f"{'no' if negate else 'a'} comment from {_name(author)}"
        wanted += "" if text is None else f" matching {_show(text)}"
        await self._settle(
            read=lambda: _comments_of(self._subject, "to_have_comment_from"),
            holds=lambda comments: any(map(_comment_from(author, text), comments)),
            describe=lambda comments: f"Expected {wanted}. The conversation has:\n{_written(comments)}",
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_comment_from(
        self, author: AuthorRef, *, text: Text | None = None, timeout: Duration | None = None
    ) -> None:
        """A comment from this author, matching `text` if given."""
        await self._comment_from(author, text, timeout, None, negate=False)

    async def not_to_have_comment_from(
        self,
        author: AuthorRef,
        *,
        text: Text | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Once the agent is quiet, no comment from this author (matching `text` if given)."""
        await self._comment_from(author, text, timeout, quiet_for, negate=True)

    async def _comments_from(
        self, author: AuthorRef, count: int, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        def found(comments: Sequence[Any]) -> int:
            return len(list(filter(_comment_from(author), comments)))

        await self._settle(
            read=lambda: _comments_of(self._subject, "to_have_comments_from"),
            holds=lambda comments: found(comments) == count,
            describe=lambda comments: (
                f"Expected {'not ' if negate else ''}exactly {count} comments from {_name(author)}, "
                f"found {found(comments)}:\n{_written(comments)}"
            ),
            negate=negate,
            once_quiet=True,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_comments_from(
        self,
        author: AuthorRef,
        *,
        count: int,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Exactly `count` comments from this author, checked once the agent is quiet."""
        await self._comments_from(author, count, timeout, quiet_for, negate=False)

    async def not_to_have_comments_from(
        self,
        author: AuthorRef,
        *,
        count: int,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Any number of comments from this author but `count`, checked once the agent is quiet."""
        await self._comments_from(author, count, timeout, quiet_for, negate=True)

    # Linear agent sessions

    async def _session_state(
        self, wanted: str, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        async def read() -> str:
            session = await _session_of(self._subject)
            return "no session" if session is None else str(await session.state())

        await self._settle(
            read=read,
            holds=lambda current: current == wanted,
            describe=lambda current: (
                f"Expected the agent session {'not ' if negate else ''}to be {wanted}, it is {current}"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_session_state(self, wanted: str, *, timeout: Duration | None = None) -> None:
        """The agent session (or an issue's latest one) is in this state: `active`, `complete`, …"""
        await self._session_state(wanted, timeout, None, negate=False)

    async def not_to_have_session_state(
        self, wanted: str, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, the agent session (or an issue's latest one) is in another state."""
        await self._session_state(wanted, timeout, quiet_for, negate=True)

    async def _activity(
        self,
        type: str | None,
        from_: AuthorRef | None,
        text: Text | None,
        timeout: Duration | None,
        quiet_for: Duration | None,
        negate: bool,
    ) -> None:
        wanted = (
            f"{type or 'activity'}{'' if from_ is None else f' from {_name(from_)}'}"
            f"{'' if text is None else f' matching {_show(text)}'}"
        )

        async def read() -> list[Any]:
            session = await _session_of(self._subject)
            activities = [] if session is None else list(await session.activities())
            return [activity for activity in activities if activity.type != "prompt"]

        def matches(activity: Any) -> bool:
            return (
                (type is None or activity.type == type)
                and (from_ is None or from_matches(activity.author, from_))
                and text_matches(getattr(activity, "body", None) or "", text)
            )

        await self._settle(
            read=read,
            holds=lambda activities: any(map(matches, activities)),
            describe=lambda activities: (
                f"Expected {'no' if negate else 'a'} {wanted}. The session has:\n"
                + _listing([f"{a.author.name} ({a.type}): {getattr(a, 'body', None) or ''}" for a in activities])
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_activity(
        self,
        *,
        type: str | None = None,
        from_: AuthorRef | None = None,
        text: Text | None = None,
        timeout: Duration | None = None,
    ) -> None:
        """The session has an activity of this type (from this author, matching `text`), people's prompts aside."""
        await self._activity(type, from_, text, timeout, None, negate=False)

    async def not_to_have_activity(
        self,
        *,
        type: str | None = None,
        from_: AuthorRef | None = None,
        text: Text | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Once the agent is quiet, the session has no such activity, people's prompts aside."""
        await self._activity(type, from_, text, timeout, quiet_for, negate=True)

    # Slack: modals and ephemeral messages

    async def _opened_modal(
        self, title: Text | None, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        await self._settle(
            read=self._subject.modals,
            holds=lambda modals: any(text_matches(modal.title, title) for modal in modals),
            describe=lambda modals: (
                f"Expected {'no' if negate else 'a'} modal{'' if title is None else f' titled {_show(title)}'} "
                f"to have been opened. Opened: {', '.join(_show(modal.title) for modal in modals) or 'none'}"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_opened_modal(self, title: Text | None = None, *, timeout: Duration | None = None) -> None:
        """Subject: a person. The agent opened a modal for them (submitted by now or not), titled `title` if given."""
        await self._opened_modal(title, timeout, None, negate=False)

    async def not_to_have_opened_modal(
        self, title: Text | None = None, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, it has opened no modal for this person (titled `title`, if given)."""
        await self._opened_modal(title, timeout, quiet_for, negate=True)

    def _ephemeral_for(self, user: Author, negate: bool) -> None:
        # It doesn't wait, as in matchers-core: who sees a message is fixed when it is posted.
        visible_to: Author | None = getattr(self._subject, "visible_to", None)
        if (visible_to is not None and visible_to.id == user.id) == negate:
            seen = "everyone can see it" if visible_to is None else f"only {visible_to.name} can"
            raise AssertionError(
                f"Expected the message {'not ' if negate else ''}to be visible only to {user.name}, {seen}"
            )

    async def to_be_ephemeral_for(self, user: Author) -> None:
        """Only this person can see the message."""
        self._ephemeral_for(user, negate=False)

    async def not_to_be_ephemeral_for(self, user: Author) -> None:
        """The message isn't one only this person can see."""
        self._ephemeral_for(user, negate=True)

    # Deliveries

    async def _attempts(self) -> list[Any]:
        return list((await self._subject.refresh()).attempts)

    async def _accepted(
        self, within: Duration | None, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        limit = None if within is None else parse_duration(within)

        async def read() -> Any:
            return next((attempt for attempt in await self._attempts() if not attempt.forged_signature), None)

        def holds(attempt: Any) -> bool:
            # Accepted, and with `within`, accepted that fast: the platform's window is only the outer limit.
            return (
                attempt is not None
                and attempt.status == "acknowledged"
                and (limit is None or (attempt.duration_ms or 0) <= limit)
            )

        def described(attempt: Any) -> str:
            expected = f"Expected delivery {self._subject.id} {'not ' if negate else ''}to be accepted"
            expected += "" if limit is None else f" within {_number(limit)}ms"
            status = "missing" if attempt is None else attempt.status
            http = "" if attempt is None or attempt.response_status is None else f" (HTTP {attempt.response_status})"
            took = "" if attempt is None or attempt.duration_ms is None else f" after {_number(attempt.duration_ms)}ms"
            return f"{expected}, its first attempt is {status}{http}{took}"

        await self._settle(
            read=read, holds=holds, describe=described, negate=negate, timeout=timeout, quiet_for=quiet_for
        )

    async def to_be_accepted(self, *, within: Duration | None = None, timeout: Duration | None = None) -> None:
        """The agent answered the delivery with 2xx, within the platform's window (and within `within`, if given)."""
        await self._accepted(within, timeout, None, negate=False)

    async def not_to_be_accepted(
        self, *, within: Duration | None = None, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, its first answer to the delivery wasn't a 2xx (within `within`, if given)."""
        await self._accepted(within, timeout, quiet_for, negate=True)

    async def _rejected(self, timeout: Duration | None, quiet_for: Duration | None, negate: bool) -> None:
        async def read() -> Any:
            forged = [attempt for attempt in await self._attempts() if attempt.forged_signature]
            return forged[-1] if forged else None

        def refused(attempt: Any) -> bool:
            return (
                attempt is not None
                and attempt.status == "failed"
                and attempt.response_status is not None
                and 400 <= attempt.response_status < 500
            )

        def described(attempt: Any) -> str:
            delivery = self._subject.id
            if attempt is None:
                return (
                    f"Expected delivery {delivery} to be rejected, but no forged attempt was sent. "
                    "Call delivery.resend(bad_signature=True) first"
                )
            answer = attempt.status if attempt.response_status is None else attempt.response_status
            return (
                f"Expected the forged attempt of delivery {delivery} {'not ' if negate else ''}to be rejected "
                f"with a 4xx, the agent answered {answer}"
            )

        await self._settle(
            read=read, holds=refused, describe=described, negate=negate, timeout=timeout, quiet_for=quiet_for
        )

    async def to_be_rejected(self, *, timeout: Duration | None = None) -> None:
        """A forged delivery (`resend(bad_signature=True)` or `stale=True`) was refused by the agent with a 4xx."""
        await self._rejected(timeout, None, negate=False)

    async def not_to_be_rejected(self, *, timeout: Duration | None = None, quiet_for: Duration | None = None) -> None:
        """Once the agent is quiet, it didn't refuse the forged delivery with a 4xx."""
        await self._rejected(timeout, quiet_for, negate=True)

    async def _retried(
        self, times: int | None, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        async def read() -> int:
            return len([attempt for attempt in await self._attempts() if not attempt.forged_signature]) - 1

        await self._settle(
            read=read,
            holds=lambda retries: retries > 0 if times is None else retries == times,
            describe=lambda retries: (
                f"Expected delivery {self._subject.id} {'not ' if negate else ''}to be retried"
                f"{'' if times is None else f' {times} times'}, it was retried {retries} times"
            ),
            negate=negate,
            once_quiet=times is not None,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_be_retried(
        self, *, times: int | None = None, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """The delivery needed retries (exactly `times` of them once the agent is quiet, if given)."""
        await self._retried(times, timeout, quiet_for, negate=False)

    async def not_to_be_retried(
        self, *, times: int | None = None, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, the delivery needed no retries (or any number but `times`, if given)."""
        await self._retried(times, timeout, quiet_for, negate=True)

    # GitHub: reviews, check runs, labels, merging

    async def _review_comment(
        self,
        path: str | None,
        line: int | None,
        from_: AuthorRef | None,
        text: Text | None,
        timeout: Duration | None,
        quiet_for: Duration | None,
        negate: bool,
    ) -> None:
        wanted = "" if path is None else f" on {path}{'' if line is None else f':{line}'}"
        wanted += "" if from_ is None else f" from {_name(from_)}"
        wanted += "" if text is None else f" matching {_show(text)}"

        def matches(comment: Any) -> bool:
            return (
                (path is None or comment.path == path)
                and (line is None or comment.line == line)
                and (from_ is None or from_matches(comment.author, from_))
                and text_matches(_comment_text(comment), text)
            )

        await self._settle(
            read=self._subject.review_comments,
            holds=lambda comments: any(map(matches, comments)),
            describe=lambda comments: (
                f"Expected {'no' if negate else 'a'} comment on the diff{wanted}. The diff has:\n"
                + _listing([f"{c.author.name} on {c.path}:{c.line}: {c.body}" for c in comments])
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_review_comment(
        self,
        *,
        path: str | None = None,
        line: int | None = None,
        from_: AuthorRef | None = None,
        text: Text | None = None,
        timeout: Duration | None = None,
    ) -> None:
        """Subject: a pull request. A comment on the diff, matched by every field that is given."""
        await self._review_comment(path, line, from_, text, timeout, None, negate=False)

    async def not_to_have_review_comment(
        self,
        *,
        path: str | None = None,
        line: int | None = None,
        from_: AuthorRef | None = None,
        text: Text | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Once the agent is quiet, no comment on the diff matches every field that is given."""
        await self._review_comment(path, line, from_, text, timeout, quiet_for, negate=True)

    async def _review_from(
        self, author: AuthorRef, state: str | None, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        def described(reviews: Sequence[Any]) -> str:
            lines = [f"{r.author.name}: {r.state}{'' if r.body == '' else f' {_show(r.body)}'}" for r in reviews]
            return (
                f"Expected {'no' if negate else 'a'} review from {_name(author)}"
                f"{'' if state is None else f' with state {state}'}. Reviews there:\n{_listing(lines)}"
            )

        await self._settle(
            read=self._subject.reviews,
            holds=lambda reviews: any(
                from_matches(review.author, author) and (state is None or review.state == state) for review in reviews
            ),
            describe=described,
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_review_from(
        self, author: AuthorRef, *, state: str | None = None, timeout: Duration | None = None
    ) -> None:
        """Subject: a pull request. A review from this author, with this verdict (`APPROVED`, …) if given."""
        await self._review_from(author, state, timeout, None, negate=False)

    async def not_to_have_review_from(
        self,
        author: AuthorRef,
        *,
        state: str | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Once the agent is quiet, no review from this author (with this verdict, if given)."""
        await self._review_from(author, state, timeout, quiet_for, negate=True)

    async def _check_run(
        self,
        name: Text,
        status: str | None,
        conclusion: str | None,
        timeout: Duration | None,
        quiet_for: Duration | None,
        negate: bool,
    ) -> None:
        wanted = ", ".join(part for part in (status, conclusion) if part is not None)

        def described(runs: Sequence[Any]) -> str:
            lines = [
                f"{run.name}: {run.status}{'' if run.conclusion is None else f', {run.conclusion}'}" for run in runs
            ]
            return (
                f"Expected {'no' if negate else 'a'} check run {_show(name)}{f' ({wanted})' if wanted else ''}. "
                f"Check runs there:\n{_listing(lines)}"
            )

        await self._settle(
            read=self._subject.check_runs,
            holds=lambda runs: any(
                _named(run.name, name)
                and (status is None or run.status == status)
                and (conclusion is None or run.conclusion == conclusion)
                for run in runs
            ),
            describe=described,
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_check_run(
        self,
        name: Text,
        *,
        status: str | None = None,
        conclusion: str | None = None,
        timeout: Duration | None = None,
    ) -> None:
        """Subject: a pull request or a commit. A check run of this name, in this status and conclusion if given."""
        await self._check_run(name, status, conclusion, timeout, None, negate=False)

    async def not_to_have_check_run(
        self,
        name: Text,
        *,
        status: str | None = None,
        conclusion: str | None = None,
        timeout: Duration | None = None,
        quiet_for: Duration | None = None,
    ) -> None:
        """Once the agent is quiet, no such check run (in this status and conclusion, if given)."""
        await self._check_run(name, status, conclusion, timeout, quiet_for, negate=True)

    async def _label(self, name: str, timeout: Duration | None, quiet_for: Duration | None, negate: bool) -> None:
        await self._settle(
            read=self._subject.labels,
            holds=lambda labels: any(label.lower() == name.lower() for label in labels),
            describe=lambda labels: (
                f"Expected {'no' if negate else 'the'} label {_show(name)}. Labels there: {', '.join(labels) or 'none'}"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_label(self, name: str, *, timeout: Duration | None = None) -> None:
        """Subject: an issue or a pull request. It has this label, compared case-insensitively."""
        await self._label(name, timeout, None, negate=False)

    async def not_to_have_label(
        self, name: str, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, the issue or pull request doesn't have this label."""
        await self._label(name, timeout, quiet_for, negate=True)

    async def _merged(self, timeout: Duration | None, quiet_for: Duration | None, negate: bool) -> None:
        await self._settle(
            read=self._subject.merged,
            holds=bool,
            describe=lambda _: f"Expected the pull request {'not ' if negate else ''}to be merged",
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_be_merged(self, *, timeout: Duration | None = None) -> None:
        """Subject: a pull request. It has been merged."""
        await self._merged(timeout, None, negate=False)

    async def not_to_be_merged(self, *, timeout: Duration | None = None, quiet_for: Duration | None = None) -> None:
        """Once the agent is quiet, the pull request isn't merged."""
        await self._merged(timeout, quiet_for, negate=True)

    # Linear issues: delegation, assignment, workflow state

    async def _principal(
        self,
        read: Callable[[], Awaitable[Any]],
        expected: Author | None,
        verb: str,
        timeout: Duration | None,
        quiet_for: Duration | None,
        negate: bool,
    ) -> None:
        """Who the issue is delegated or assigned to, compared by id; `None` asks for no one."""
        await self._settle(
            read=read,
            holds=lambda current: (
                current is None if expected is None else current is not None and current.id == expected.id
            ),
            describe=lambda current: (
                f"Expected the issue {'not ' if negate else ''}to be {verb} to "
                f"{'no one' if expected is None else expected.name}, it is {verb} to "
                f"{'no one' if current is None else current.name}"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_be_delegated_to(self, app: Author | None, *, timeout: Duration | None = None) -> None:
        """Subject: a Linear issue. It is delegated to this app, or (with `None`) to none."""
        await self._principal(self._subject.delegated_to, app, "delegated", timeout, None, negate=False)

    async def not_to_be_delegated_to(
        self, app: Author | None, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, the issue isn't delegated to this app (or, with `None`, it is to one)."""
        await self._principal(self._subject.delegated_to, app, "delegated", timeout, quiet_for, negate=True)

    async def to_be_assigned_to(self, user: Author | None, *, timeout: Duration | None = None) -> None:
        """Subject: a Linear issue. It is assigned to this person, or (with `None`) to no one."""
        await self._principal(self._subject.assignee, user, "assigned", timeout, None, negate=False)

    async def not_to_be_assigned_to(
        self, user: Author | None, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, the issue isn't assigned to this person (or, with `None`, it is to someone)."""
        await self._principal(self._subject.assignee, user, "assigned", timeout, quiet_for, negate=True)

    async def _state(self, name: str, timeout: Duration | None, quiet_for: Duration | None, negate: bool) -> None:
        async def read() -> str:
            return str((await self._subject.state()).name)

        await self._settle(
            read=read,
            holds=lambda current: current.lower() == name.lower(),
            describe=lambda current: (
                f"Expected the issue {'not ' if negate else ''}to be in {_show(name)}, it is in {_show(current)}"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_state(self, name: str, *, timeout: Duration | None = None) -> None:
        """Subject: a Linear issue. Its workflow state, by name, compared case-insensitively."""
        await self._state(name, timeout, None, negate=False)

    async def not_to_have_state(
        self, name: str, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, the issue is in another workflow state."""
        await self._state(name, timeout, quiet_for, negate=True)

    # Notion pages: blocks and properties

    async def _block(self, text: Text, timeout: Duration | None, quiet_for: Duration | None, negate: bool) -> None:
        async def read() -> list[str]:
            return _block_texts(await self._subject.blocks())

        await self._settle(
            read=read,
            holds=lambda texts: any(text_matches(line, text) for line in texts),
            describe=lambda texts: (
                f"Expected the page {'not ' if negate else ''}to have a block matching {_show(text)}. "
                f"Its blocks:\n{_listing(texts)}"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_block(self, text: Text, *, timeout: Duration | None = None) -> None:
        """Subject: a Notion page. A block (at any depth) whose text matches; a child page's title counts."""
        await self._block(text, timeout, None, negate=False)

    async def not_to_have_block(
        self, text: Text, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, no block of the page (at any depth) matches."""
        await self._block(text, timeout, quiet_for, negate=True)

    async def _property_value(
        self, name: str, expected: object, timeout: Duration | None, quiet_for: Duration | None, negate: bool
    ) -> None:
        async def read() -> object:
            return await self._subject.property(name)

        await self._settle(
            read=read,
            holds=lambda value: value == expected,
            describe=lambda value: (
                f"Expected {name} {'not ' if negate else ''}to be {expected}, "
                f"it is {json.dumps(value, ensure_ascii=False, default=str)}"
            ),
            negate=negate,
            timeout=timeout,
            quiet_for=quiet_for,
        )

    async def to_have_property_value(self, name: str, expected: object, *, timeout: Duration | None = None) -> None:
        """Subject: a Notion page (a database row). A property has this value, compared with `==`.

        So `unittest.mock.ANY`, or any object with its own `__eq__`, works as TypeScript's asymmetric matchers do.
        """
        await self._property_value(name, expected, timeout, None, negate=False)

    async def not_to_have_property_value(
        self, name: str, expected: object, *, timeout: Duration | None = None, quiet_for: Duration | None = None
    ) -> None:
        """Once the agent is quiet, the property has another value."""
        await self._property_value(name, expected, timeout, quiet_for, negate=True)


def expect(subject: Any) -> Expectation:
    """The checks on a subject: `await expect(msg.thread).to_have_reply_from("my-agent")`."""
    return Expectation(subject)
