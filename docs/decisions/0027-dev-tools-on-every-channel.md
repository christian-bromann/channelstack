# 0027: The dev tools act on every channel, through a dev adapter and the generated actions

Status: accepted, 2026-11-27. The direction was agreed with the maintainer; this records how it was built.

## Context

The attach CLI and `channelstack mcp` (decision 0010, devx.md 4a and 4b) acted only on Slack:
`slack say|reply|react|click|stop` and `show`, written once in `server/src/cli/slack.ts` against
Slack's routes. GitHub, Linear and Notion tools were asked for in #33 and closed: those channels had
no routes that list people and places, so the CLI couldn't find "mo" or "Login fails" again on its
next run. Resend, Gmail (and Twilio and Discord, in their pull requests) never had any. The UI listed
Slack's conversations only.

Every channel's control API already has the same shape: `/users`, `/users/{user}/<action>`, a
transcript per place, and the inspection routes. The SDKs are generated from that shape
(`x-channelstack-*`, decision 0025). The dev tools can be too.

## What was decided

- **A dev adapter per channel, on the kit.** `core/dev` defines `DevAdapter`, and each driver's
  definition has one (`dev`, in the driver's `dev.ts`; the email channels share `core/email/dev.ts`).
  It is written against the channel's control API, so the CLI, MCP and the UI use the same code. An
  adapter says only what differs: what a place is (a Slack channel, a GitHub issue or pull request in
  the org's public `dev` repository, a Linear issue in a team named Dev, a Notion page connected to
  the integration, an email thread to the agent), how its places are listed (`listing`: a list route
  and templates for a place's id, name and transcript), how to make one with the app in it, how a
  person says, replies and reacts there, and which handles an entry stands for (`refs`).
- **Written once in the kit:** a person by name, made on first use; a place by name, made on first
  use; `last` (the newest entry of the most recently active place, by the transcripts' times, of
  equal times the one listed later; Slack says which entry is newest itself, `newest`); references,
  `<place>:<entry>` with the ids `show --json` lists, or a place by name; and who started a thread.
- **List routes, one per channel and kind:** `GET /users` on every channel, GitHub's `/repos` and
  `/issues`, Linear's `/teams` and `/issues`, Notion's `/pages`, the email channels' `/threads`.
  Slack had `/users` and `/conversations`. They are fixture reads in the SDKs too
  (`github.issues()`). GitHub's and Linear's issue lists answer `{ issue, title }`: the issue handles
  already have a `title()` read, which a field can't share a name with.
- **Shared verbs with a channel:** the MCP tools `say`, `reply`, `react` and `show` take `channel`;
  the CLI has `channelstack <channel> say|reply|react|show`. `react` is there for the channels whose
  people react (Slack, GitHub, Linear) and says so on the others. `show` without a channel shows the
  most recently active place of any channel, as `channelstack show` did for Slack. `tail`,
  `list_deliveries` and `redeliver` stay as they were.
- **Everything else a person does is generated.** `codegen/src/emit/dev.ts` writes
  `server/src/cli/generated/actions.ts` from the IR, with the SDKs (`pnpm sdk`, checked by
  `sdk:check`): per channel, every method of its person handle that isn't a read, with its values
  and their types, and the handles and named types they refer to. MCP has one `<channel>_act` tool
  per channel, with the actions as an enum and their signatures in its description; the CLI has
  `channelstack <channel> <action>` (and `act <action>` for one named like a verb), with values in
  order or as `--<name>`. Written once (`cli/act.ts`): a value is read by its type (a number, a
  shorthand like a button's label, JSON for an object), a person or the app by name, `last` as the
  target's handle, and a reference the action needs and wasn't given is filled from the target (the
  entry `--on` names, the newest one `--in` a place, or `last`), as is the place itself when the
  action takes it and no reference was given. Without `--as`, whoever started the target's thread acts.
- **The UI lists every channel** from the same `listing` declarations, which the server puts into
  the page as JSON. Its controls stay read-only.
- **`pnpm check:channels` requires the adapter** for every channel, and a case for it in
  `server/src/cli/dev.test.ts`, which drives say, reply, react, show and an action of each channel
  against the server in memory.

## Why

- One adapter per channel keeps what is really per-channel small (60 to 90 lines each) and makes
  the rest the same everywhere, so a new channel gets the dev tools by writing one file, and
  `check:channels` names it when it is missing.
- Generating the actions means 70-odd actions don't need 70 hand-written tools or commands, and an
  action added to the routes shows up in the CLI and MCP with no change there. One tool per channel
  with an enum keeps the tool list short for a coding agent, and the description still lists each
  action's values.
- The shared verbs are the dev loop's 90%: say something, read the answer, reply. They are where a
  channel's words differ most (a Slack message, a GitHub comment, a Notion discussion, an email
  reply), which is why the adapter writes them and the generator doesn't.

## Alternatives

- **"Find or create" routes on the server, per channel** (as 0010 rejected for Slack). Still
  rejected: a second way to create things that tests don't want, and the SDKs would have them too.
- **One MCP tool per action** (`github_review`, `linear_delegate`, …). Rejected: over 70 tools, which
  crowd a coding agent's context, for what one tool per channel says as well.
- **Generate the shared verbs too**, from a marker on the routes (`x-channelstack-dev: say`). Rejected
  for now: which route is a channel's "say" depends on whether the place exists yet (GitHub opens an
  issue or comments on it), which is code, not a marker.
- **The UI reads a new control route** that runs the adapters on the server. Rejected: a route only
  the UI needs, in every SDK; the listing declarations are plain data the page can read itself.
