# 0011: The reference agents

Status: accepted, phase 1.

## Context

Exit checks 1.1 and 1.2 run `api/examples` unchanged against two agents on different frameworks; 1.4 needs a deliberately broken one.

## Decision

- The agents are plain programs in `examples/agents/`, with **no channelstack code** in them (`pnpm check:deps` enforces it). They read what `channelstack env` prints.
- Both answer from **one scripted model** (`shared/scripted-model.ts`): fixed short answers, and the AI SDK's own mock model for streamed long-form. channelstack doesn't mock models; the agents use their framework's fake.
- The streamed answer is longer than 256 characters on purpose. Slack's `ChatStreamer`, which the Chat SDK uses, buffers that much before its first call, so a shorter answer is never visibly "streaming".
- The Chat SDK agent turns on the adapter's **agent messaging** mode (`agentView`). Without it the adapter answers a DM at the top level, with no thread, and can't set a status; the examples describe an agent that answers in the thread of the message and shows what it is doing.
- `mdac-220` reproduces the bug as it happened: it opens its reply with "Thinking…", the model call fails, the error is swallowed, and the stream is never stopped.

## What the second agent found

Running the same examples against the Chat SDK showed three gaps in the fake, fixed in this phase: thread titles and suggested prompts (`assistant.threads.setTitle`, `setSuggestedPrompts`, `agents.sessions.rename`), the quiet rule after a rate limit (decision 0009), and how short streams look to a person.
