# 0018: pytest checks are `expect(subject).to_…()`

Status: accepted, phase 7.

pytest-channelstack's checks mirror the Vitest matchers one to one, in Python's spelling:

```python
from pytest_channelstack import expect

await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("incident", re.I))
await expect(channel).not_to_have_channel_message_from("my-agent")
```

`toHaveReplyFrom` becomes `to_have_reply_from`, and Vitest's `.not.` becomes a `not_to_…` method. Each check
has the matcher's semantics (`integrations/matchers-core`): a positive check polls until it holds; a negative
or exact-count check waits until the agent has been quiet for the whole window, then checks once; a failure
says what the thread had and what the agent left open.

## Why

- **One vocabulary.** A team with agents in TypeScript and Python reads the same check names in both, and the
  docs explain each matcher once.
- **The landing page already shows it.** The Python samples on the home page use `expect(...)`, and
  Playwright for Python made the shape familiar to pytest users.
- **Checks are awaited.** They wait for the agent, so a plain `assert` can't express them; an awaitable method
  says that it waits.

## What changes

- docs/devx.md section 5 named a placeholder helper (`assert_shows_once`); it now shows `expect(...)`.
- phase 7 ports the conversation matchers (replies, channel messages, streaming, status, reactions, the agent's
  calls). The rest of the matcher set follows the same pattern later (docs/phases.md, "After 0.1").

## Alternatives considered

- **Assertion functions** (`await assert_reply_from(thread, "my-agent")`). Rejected: a second vocabulary next to
  the TypeScript matchers, and the negations read awkwardly (`assert_no_replies_from(…, count=1)`).
- **Plain `assert` with a pytest assertion-rewriting hook.** Rejected: the checks wait, and `assert` can't await.
