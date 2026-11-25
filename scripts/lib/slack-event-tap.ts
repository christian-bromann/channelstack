/**
 * The Slack reference agent, started so the live run sees what Slack sends it (live-mode.md 6,
 * #28): each event's body is handed to the parent process (`process.send`) before Bolt handles
 * it, unchanged. The agent keeps its own Socket Mode connection to Slack, so nothing is relayed
 * and no second connection takes events from it.
 *
 * Usage: `node scripts/lib/slack-event-tap.ts <agent.ts>`, spawned with an IPC channel.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { App } from "@slack/bolt";

const [path] = process.argv.slice(2);
if (!path || !process.send) throw new Error("Usage: spawned with IPC, `slack-event-tap.ts <agent.ts>`");
const agent = resolve(path);

// The Bolt the reference agents import: one root dependency, so this is their `App`. Should it
// ever stop being theirs, nothing is recorded and `pnpm conformance` fails (decision 0020).
const processEvent = App.prototype.processEvent;
App.prototype.processEvent = function (this: App, event) {
  // With a callback, a closed channel is an error passed here, not one that stops the agent.
  if (process.connected) process.send?.({ slackEvent: event.body }, undefined, {}, () => {});
  return processEvent.call(this, event);
};

await import(pathToFileURL(agent).href);
