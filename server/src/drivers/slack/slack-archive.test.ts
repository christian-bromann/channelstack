import { afterEach, describe, expect, test, vi } from "vitest";

import { type RecordingAgent, recordingAgent } from "../../../test/app-harness.ts";
import { driverContext } from "../../../test/driver-context.ts";
import { createSlackFake } from "./fake/index.ts";

const agents: RecordingAgent[] = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
});

/**
 * The Slack fake on its own, delivering to a stand-in agent: the built-in app has no scope to
 * archive a channel (as a conversational agent's app usually doesn't), so a test grants it here.
 */
async function fake(grant: readonly string[] = []) {
  const agent = await recordingAgent();
  agents.push(agent);
  const slack = createSlackFake(driverContext({ webhookUrl: agent.url, apiUrl: () => "http://127.0.0.1:4500/slack" }));
  Object.assign(slack.store.app, { scopes: [...slack.store.app.scopes, ...grant] });
  const bot = slack.store.app.botUserId;
  const ana = slack.world.createUser("ses_a", { name: "Ana" });
  const api = async (method: string, args: Record<string, unknown>) => {
    const response = await slack.api.fetch(
      new Request(`http://slack.localhost/api/${method}`, {
        method: "POST",
        headers: { authorization: "Bearer secret-for-botToken", "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
    );
    return (await response.json()) as Record<string, unknown>;
  };
  const events = () => agent.received.map((delivery) => JSON.parse(delivery.body));
  return { slack, agent, bot, ana, api, events };
}

describe("conversations.archive", () => {
  test("without channels:manage the app is refused, as the built-in app's real counterpart is", async () => {
    const { slack, bot, ana, api } = await fake();
    const channel = slack.world.createChannel("ses_a", { participants: [ana.id, bot] });
    expect(await api("conversations.archive", { channel: channel.id })).toMatchObject({
      ok: false,
      error: "missing_scope",
      needed: "channels:manage",
    });
    const secret = slack.world.createChannel("ses_a", { private: true, participants: [ana.id, bot] });
    expect(await api("conversations.archive", { channel: secret.id })).toMatchObject({
      ok: false,
      error: "missing_scope",
      needed: "groups:write",
    });
    expect(channel.isArchived).toBe(false);
  });

  test("archiving posts the channel_archive message; the channel can still be read, not written to", async () => {
    const { slack, bot, ana, api, events } = await fake(["channels:manage"]);
    const channel = slack.world.createChannel("ses_a", { participants: [ana.id, bot] });
    const before = slack.world.postAsApp(channel, { text: "before the archive" }, {});
    await vi.waitFor(() => expect(events()).toHaveLength(1));

    expect(await api("conversations.archive", { channel: channel.id })).toEqual({ ok: true });
    await vi.waitFor(() => expect(events()).toHaveLength(2));
    const archived = events()[1];
    // Field for field what a real workspace sent, in the envelope a real workspace sent it in.
    expect(archived.event).toEqual({
      type: "message",
      subtype: "channel_archive",
      user: bot,
      text: "archived the channel",
      ts: expect.stringMatching(/^\d{10}\.\d{6}$/),
      channel: channel.id,
      event_ts: archived.event.ts,
      channel_type: "channel",
    });
    expect(archived).toMatchObject({ context_team_id: slack.store.team.id, context_enterprise_id: null });

    expect((await api("conversations.info", { channel: channel.id })).channel).toMatchObject({ is_archived: true });
    expect(await api("conversations.history", { channel: channel.id })).toMatchObject({ ok: true });
    expect(await api("conversations.members", { channel: channel.id })).toMatchObject({ ok: true });
    // A real workspace let the bot add and remove reactions in an archived channel (recorded 2026-11-26).
    expect(await api("reactions.add", { channel: channel.id, timestamp: before.ts, name: "eyes" })).toEqual({
      ok: true,
    });
    expect(await api("reactions.remove", { channel: channel.id, timestamp: before.ts, name: "eyes" })).toEqual({
      ok: true,
    });
    expect(await api("chat.postMessage", { channel: channel.id, text: "still here?" })).toEqual({
      ok: false,
      error: "is_archived",
    });
    expect(await api("conversations.archive", { channel: channel.id })).toEqual({
      ok: false,
      error: "already_archived",
    });
  });

  test("it refuses what Slack refuses: #general, a DM, a channel the app isn't in, one that doesn't exist", async () => {
    const { slack, bot, ana, api, events } = await fake(["channels:manage", "groups:write"]);
    const general = slack.world.createChannel("ses_a", { name: "general", participants: [ana.id, bot] });
    const elsewhere = slack.world.createChannel("ses_a", { participants: [ana.id] });
    const secret = slack.world.createChannel("ses_a", { private: true, participants: [ana.id] });
    const dm = slack.world.openConversation("ses_a", ana.id, [bot]);
    const refused = async (channel: string) => (await api("conversations.archive", { channel })).error;
    expect(await refused(general.id)).toBe("cant_archive_general");
    expect(await refused(dm.id)).toBe("method_not_supported_for_channel_type");
    expect(await refused(elsewhere.id)).toBe("not_in_channel");
    // Slack doesn't reveal a private channel the app isn't in.
    expect(await refused(secret.id)).toBe("channel_not_found");
    expect(await refused("C0NOTHING00")).toBe("channel_not_found");
    expect(events()).toEqual([]);
  });

  test("a private channel's archive message says `group`", async () => {
    const { slack, bot, ana, api, events } = await fake(["groups:write"]);
    const secret = slack.world.createChannel("ses_a", { private: true, participants: [ana.id, bot] });
    expect(await api("conversations.archive", { channel: secret.id })).toEqual({ ok: true });
    await vi.waitFor(() => expect(events()).toHaveLength(1));
    expect(events()[0].event).toMatchObject({ subtype: "channel_archive", channel_type: "group" });
  });
});
