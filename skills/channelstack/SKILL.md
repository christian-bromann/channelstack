---
name: channelstack
description: Try a Slack bot you are building against channelstack's fake Slack, through the channelstack MCP tools or CLI. Post as a person, read what the bot answered, see what was delivered to it and what it called, redeliver, and check again. Use when changing an agent that lives in Slack, GitHub, Linear or Notion and you want to see it answer before you write the test.
---

# channelstack

channelstack fakes Slack, GitHub, Linear, Notion and Resend in memory. Your bot talks to the fake as if it were the real platform; you act as people in it and read what a person would see.

## Set up, once

1. Start the server in its own terminal, telling it where the bot takes events: `CHANNELSTACK_SLACK_WEBHOOK_URL=http://localhost:3000/slack/events npx channelstack` (`CHANNELSTACK_<CHANNEL>_WEBHOOK_URL` for the others). A Socket Mode bot connects out by itself and needs none. The server stays in the foreground.
2. Point the bot at it: `npx channelstack env >> .env.local` adds its tokens, signing secrets and API URLs. Restart the bot.
3. Add the MCP server to the coding agent:

   ```json
   { "mcpServers": { "channelstack": { "command": "npx", "args": ["channelstack", "mcp"] } } }
   ```

Everything happens in one long-lived `dev` session, shared with the CLI and the UI. People and channels are created the first time you name them.

## The loop

1. **Act as a person.** `slack_say` with `as: "ana"`, `channel: "#support"`, `text: "@my-agent summarize today"`. Follow up with `slack_reply`, `slack_react`, `slack_click` (a button's label) or `slack_stop`.
2. **Read the answer.** `show_thread` shows the latest conversation as a person reads it. The bot works asynchronously: if its reply isn't there yet, call it again.
3. **See why.** `tail` returns what happened since its last call: events delivered to the bot (`→ slack app_mention  200`) and the API calls it made (`← slack chat.postMessage  200`). A delivery that failed, or a call refused with an error code, is usually the bug.
4. **Change the bot, then send the same event again.** `list_deliveries` lists them with ids (`channel: "slack"` for Slack's only); `redeliver` sends the newest again (or one by `delivery` id), the way Slack retries (with its retry headers). A bot that answers twice doesn't handle retries.
5. **Check again** with `show_thread`.

The same commands exist on the CLI: `channelstack slack say --as ana --in "#support" "@my-agent hi"`, `channelstack show`, `channelstack tail`, `channelstack deliveries`, `channelstack redeliver last`.

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

pytest is the same with `pytest-channelstack`: `await expect(msg.thread).to_have_reply_from("my-agent")`.

## Good to know

- State is in memory: restarting the server starts from nothing. Run `npx channelstack env` again only after `channelstack secrets rotate`.
- channelstack doesn't run the bot or its model. Use your framework's fake model in tests.
- The tools never return the server's token. Don't paste tokens from `.env` into chat either.
- GitHub, Linear, Notion and Resend have no MCP tools beyond `list_deliveries` and `redeliver`; drive them from a test.
