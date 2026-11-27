/**
 * The Discord reference agent, started so the differential run sees what its Gateway sends it
 * (live-mode.md 6): each dispatch, as discord.js reads it, unchanged. The agent keeps its own
 * Gateway connection, so nothing is relayed and no second connection takes events from it.
 *
 * - Live, spawned with an IPC channel (`node scripts/lib/discord-event-tap.ts <agent.ts>`): each
 *   dispatch goes to the parent process (`process.send`), whose recorder writes its shape.
 * - Against the fake, as the stack's agent: `CHANNELSTACK_DISCORD_TAP_AGENT` names the agent and
 *   `CHANNELSTACK_DISCORD_TAP_RECORD` the recorder's directory, and the tap writes the shapes itself.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client, Events } from "discord.js";

import { createRecorder } from "../../server/src/core/proxy/record.ts";

const path = process.argv[2] ?? process.env.CHANNELSTACK_DISCORD_TAP_AGENT;
const recordIn = process.env.CHANNELSTACK_DISCORD_TAP_RECORD;
if (!path || (!process.send && !recordIn)) {
  throw new Error(
    "Usage: spawned with IPC, `discord-event-tap.ts <agent.ts>`, or with CHANNELSTACK_DISCORD_TAP_AGENT and _RECORD",
  );
}
const agent = resolve(path);
const recorder = process.send ? undefined : createRecorder(recordIn as string);

/** Hand one dispatch on: to the parent process, or to the recorder here. */
const tapped = (t: string, d: unknown) => {
  if (recorder) recorder.webhook("discord", t, JSON.stringify(d));
  // With a callback, a closed channel is an error passed here, not one that stops the agent.
  else if (process.connected) process.send?.({ discordEvent: { t, d } }, undefined, {}, () => {});
};

// The discord.js the reference agent imports: one root dependency, so this is its `Client`. Should it
// ever stop being its, nothing is recorded and `pnpm conformance` fails.
const emit = Client.prototype.emit;
Client.prototype.emit = function (this: Client, event: string | symbol, ...args: unknown[]) {
  const [packet] = args as [{ t?: unknown; d?: unknown } | undefined];
  if (event === Events.Raw && typeof packet?.t === "string") tapped(packet.t, packet.d);
  return emit.call(this, event as never, ...(args as never[]));
} as typeof Client.prototype.emit;

await import(pathToFileURL(agent).href);
