---
name: channelstack
description: Try a bot you are building against channelstack's fake Slack, GitHub, Linear, Notion, Resend, Gmail or Discord, and its model against the fake OpenAI, through the channelstack MCP tools or CLI. Post as a person, script what the model answers, read what the bot answered, act as people do on the platform (click, review, delegate, …), see what was delivered to it and what it called, redeliver, and check again. Use when changing an agent that lives in Slack, GitHub, Linear, Notion, email or Discord and you want to see it answer before you write the test.
---

# channelstack

channelstack fakes Slack, GitHub, Linear, Notion, Resend, Gmail (`google`) and Discord in memory, and OpenAI's API for the bot's model at `https://openai.localhost/v1`. Your bot talks to the fake as if it were the real platform; you act as people in it and read what a person would see.

## Set up, once

1. Start the server in its own terminal, telling it where the bot takes events: `CHANNELSTACK_SLACK_WEBHOOK_URL=http://localhost:3000/slack/events npx channelstack` (`CHANNELSTACK_<CHANNEL>_WEBHOOK_URL` for the others). A Socket Mode bot connects out by itself and needs none. The server stays in the foreground.
2. Point the bot at it: `npx channelstack env >> .env.local` adds its tokens, signing secrets and API URLs, and `OPENAI_BASE_URL` and `OPENAI_API_KEY` for its model (the `openai` SDKs and the AI SDK's OpenAI provider read both by themselves). Restart the bot.
3. Add the MCP server to the coding agent:

   ```json
   { "mcpServers": { "channelstack": { "command": "npx", "args": ["channelstack", "mcp"] } } }
   ```

Everything happens in one long-lived `dev` session, shared with the CLI and the UI. People and places are created the first time you name them, with the bot in them. A place is what people talk in, by its name: a Slack channel (`"#support"`), a GitHub issue or pull request by its title, a Linear issue by its title, a Notion page by its title, an email thread by its subject (`resend` or `google`), a Discord channel (`"#support"`).

## The loop

1. **Script the model, if the bot has one on the fake OpenAI.** There is no default answer: a model call nothing scripted gets a 400 (`channelstack_no_script`). `openai_respond` with `text: "Two incidents yesterday."` answers the next call; `times: -1` answers every call, `when: "deploy"` only calls whose newest user message has that text, and `tool: "search_incidents"` with `args: "{\"since\":\"yesterday\"}"` has the model call that tool first and answer its result with `text`. The text may use `{lastUserText}` and `{toolResult}`. `openai_calls` lists what the bot asked and what the model answered.
2. **Act as a person.** `say` with `channel: "slack"`, `as: "ana"`, `in: "#support"`, `text: "@my-agent summarize today"` (or `channel: "github"`, `in: "Login fails"`, …). Follow up with `reply` or `react`, which take `last` by default. Everything else people do on a channel is its `<channel>_act` tool: `slack_act` with `action: "click"` and `params: { "button": "Approve" }`, `github_act` with `action: "review"`, `linear_act` with `action: "delegate"`. Its description lists the actions and their values; references an action needs (the message, the issue, the app) come from the newest entry, or from `on` / `in`.
3. **Read the answer.** `show` shows the most recently active place as a person reads it (`channel` and `in` for another, `json: true` for the entries' ids). The bot works asynchronously: if its reply isn't there yet, call it again.
4. **See why.** `tail` returns what happened since its last call: events delivered to the bot (`→ slack app_mention  200`) and the API calls it made (`← slack chat.postMessage  200`). A delivery that failed, or a call refused with an error code, is usually the bug.
5. **Change the bot, then send the same event again.** `list_deliveries` lists them with ids (`channel: "slack"` for Slack's only); `redeliver` sends the newest again (or one by `delivery` id), the way Slack retries (with its retry headers). A bot that answers twice doesn't handle retries.
6. **Check again** with `show`.

The same commands exist on the CLI: `channelstack slack say --as ana --in "#support" "@my-agent hi"`, `channelstack github say --as mo --in "Login fails" "@my-agent look"`, `channelstack slack click --as ana Approve`, `channelstack slack actions`, `channelstack show`, `channelstack tail`, `channelstack deliveries`, `channelstack redeliver last`, `channelstack openai respond --times -1 "Here's what I found."`, `channelstack openai calls`, `channelstack openai undo ms_…`.

## Then write the test

Once it behaves, pin it down in a test, which gets a fresh session and creates its own people:

```ts
test("a mention gets exactly one reply, in the thread", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const msg = await ana.say("@my-agent summarize yesterday's incidents", { channel });

  await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /incident/i });
  await expect(msg.thread).toHaveRepliesFrom(slack.app, { count: 1 });
});
```

A bot with a model scripts it in the test with the `openai` fixture; a call the test didn't script fails it:

```ts
test("a tool loop ends in one answer", async ({ slack, openai }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const ai = await openai.respond([
    { toolCalls: [{ name: "search_incidents", arguments: { since: "yesterday" } }] },
    "Two incidents yesterday: the web deploy and a DNS blip.",
  ]);
  const msg = await ana.say("what broke yesterday?", { to: slack.app });

  await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /DNS blip/ });
  await expect(ai).toHaveAnswered({ times: 2 });
  await expect(openai).not.toHaveSentSecrets();
});
```

A turn can also be an error (`{ error: "overloaded" }`), a stream that breaks (`{ text: ["a", "b"], failAfter: { chunks: 1, how: "drop" } }`) or a slow one (`{ timing: { firstToken: "5s" } }` as the second argument); `openai.respond((request) => …)` computes the answer from what the bot sent.

pytest is the same with `pytest-channelstack`: `await expect(msg.thread).to_have_reply_from("my-agent")`, and the `openai` fixture.

## Good to know

- State is in memory: restarting the server starts from nothing. Run `npx channelstack env` again only after `channelstack secrets rotate`.
- channelstack doesn't run the bot. Its model is the fake OpenAI when the bot uses `OPENAI_BASE_URL`; a framework's own fake model or a real one works too. Images, audio, files and OpenAI's built-in tools aren't in the fake yet.
- The tools never return the server's token. Don't paste tokens from `.env` into chat either.
- Notion and email have no reactions: `react` says so. A Linear reaction is on a comment, not the issue.
