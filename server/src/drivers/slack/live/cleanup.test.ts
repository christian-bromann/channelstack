import { describe, expect, test } from "vitest";

import { slackStub } from "../../../../test/slack-live-stub.ts";
import { systemTimers } from "../../../core/clock/index.ts";
import type { LedgerEntry } from "../../../core/ledger/index.ts";
import { LiveCredential } from "../../../core/secrets/index.ts";
import { removeSlackEntry } from "./cleanup.ts";
import { SlackWebClient } from "./client.ts";

/** Ana and the app in a DM, with a client and the credentials cleanup uses. */
async function dm() {
  const stub = slackStub();
  const ana = stub.person("ana");
  const client = new SlackWebClient({ base: stub.apiBase, fetch: stub.fetch, timers: systemTimers });
  const anaToken = new LiveCredential("user:ANA", ana.token);
  const botToken = new LiveCredential("app", stub.bot.token);
  const opened = await client.call("conversations.open", anaToken, { users: stub.bot.userId });
  const channel = (opened.channel as { id: string }).id;
  const credentials = {
    byOwner: (owner: string) => (owner === "app" ? botToken : owner === "user:ANA" ? anaToken : undefined),
    byUser: (user: string) => (user === stub.bot.userId ? botToken : user === ana.userId ? anaToken : undefined),
  };
  const entry = (ts: string, extra: Record<string, string> = {}): LedgerEntry => ({
    id: `run1-s1-${ts}`,
    channel: "slack",
    kind: "message",
    ref: { channel, ts, ...extra },
    workspace: stub.team,
    by: "user:ANA",
    run: "run1",
    session: "ses_a",
    createdAt: 0,
  });
  return { stub, ana, client, credentials, channel, entry };
}

describe("exit check 5.2: removing what a session wrote in a DM", () => {
  test("a message goes with the replies under it, each deleted by whoever wrote it", async () => {
    const { stub, ana, client, credentials, channel, entry } = await dm();
    const asked = stub.typed(ana.userId, channel, "are you there?");
    stub.botSays(channel, "Yes", asked);
    stub.typed(ana.userId, channel, "great", asked);
    await removeSlackEntry(client, credentials, entry(asked));
    expect(stub.channel(channel)?.messages).toEqual([]);
  });

  test("what another session wrote in the same DM stays", async () => {
    const { stub, ana, client, credentials, channel, entry } = await dm();
    const mine = stub.typed(ana.userId, channel, "first");
    stub.botSays(channel, "answer to first", mine);
    // The same real DM: a person has one with the app, whichever session writes in it.
    const theirs = stub.typed(ana.userId, channel, "second");
    stub.botSays(channel, "answer to second", theirs);

    await removeSlackEntry(client, credentials, entry(mine));
    expect(stub.channel(channel)?.messages.map((message) => message.text)).toEqual(["second", "answer to second"]);
  });

  test("a reply the session wrote in someone's thread goes alone", async () => {
    const { stub, ana, client, credentials, channel, entry } = await dm();
    const root = stub.botSays(channel, "How can I help?");
    const reply = stub.typed(ana.userId, channel, "deploy web", root);
    await removeSlackEntry(client, credentials, entry(reply, { thread: root }));
    expect(stub.channel(channel)?.messages.map((message) => message.text)).toEqual(["How can I help?"]);
  });

  test("something already gone is done, not a failure", async () => {
    const { client, credentials, entry } = await dm();
    await expect(removeSlackEntry(client, credentials, entry("1800000000.000001"))).resolves.toBeUndefined();
  });
});
