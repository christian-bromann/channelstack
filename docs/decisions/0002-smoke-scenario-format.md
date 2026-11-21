# 0002: The smoke scenario format

Status: accepted, phase 0.

## Context

architecture.md 5.4 calls for about ten protocol scenarios in "a small YAML step format" under `scenarios/smoke/`, run through every SDK, like WebDriver's WPT. No document defined the format.

## Decision

A scenario is a YAML file with a name and a list of steps. Each SDK has a runner of about 150 lines (`scenarios/runners/<language>/`) that interprets it through that SDK's public API.

```yaml
name: echo
description: One sentence on what the scenario proves.
requires: [echo-agent]          # optional: what must run next to the server
steps:
  - call: echo.createUser       # <variable>.<method>, names as in spec/ir.json (camelCase)
    options: { name: Ana }      # the method's trailing options object
    as: ana                     # save the result
  - call: ana.say
    args: [hello]               # positional arguments
    options: { room: $room }    # $name is a saved value; handles are passed as handles
    as: message
  - expect:                     # checks on saved values
      - { value: $message.text, equals: hello }
  - call: room.messages
    as: page
    until:                      # repeat the call until every check holds, or time out
      - { value: $page.messages.length, equals: 2 }
  - call: ben.say
    args: [hi]
    options: { room: $room }
    throws: not_in_room         # the call must fail with this protocol error code
```

Rules:

- **Variables.** `channelstack` (the client) and `session` (a session opened for the scenario) exist from the start. `as` adds more.
- **References.** A string starting with `$` is a path into a saved value: `$page.messages.1.author.id`. A number indexes a list, `length` is its size, and a missing value reads as `null`. Write `$$` for a literal `$`.
- **Checks.** `equals` compares exactly; `matches` is a regular expression; `contains` passes when a list has an item that equals the value, or, for a mapping, an item that has at least those fields.
- **Names.** Scenarios use the IR's names. A runner converts them to its language's idiom (Python: `create_user`, `bot_user_id`).
- **Strings.** Quote any string that contains `?`, `:`, `#` or starts with a special character: PyYAML reads YAML 1.1 and the TypeScript runner reads YAML 1.2, and they disagree on some plain scalars.
- **Modes.** A scenario that `requires: [echo-agent]` runs attached to a server that `scripts/smoke.ts` started next to the reference agent. The others run in `start` mode, so the SDK's own launcher starts the binary. Together they cover both launcher paths in every language.

Waiting uses the SDK runtime's `wait` module, so the scenarios also exercise the one polling loop.

## Why

- **Language-neutral.** The same file proves that every SDK drives the protocol the same way; a scenario written in TypeScript could not run from Python or Rust.
- **Small on purpose.** No variables beyond results, no loops, no conditionals. A scenario that needs more belongs in the per-driver acceptance tests (`api/examples`), not here.

## Alternatives considered

- **Port each scenario by hand to every language.** Rejected: ports drift, and parity would be asserted rather than tested.
- **An existing format (Gherkin, Tavern, Hurl).** Rejected: they describe HTTP calls or prose steps, not calls on SDK handle objects, which is the thing under test.
