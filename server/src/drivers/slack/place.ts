import type { MessagePlace } from "../../core/router/index.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * Where the message a Slack delivery tells the agent about is: who wrote it, the conversation,
 * the thread and the message, by Slack's ids. An Events API callback has them in its `event`; an
 * interaction (a click) in its form's `payload`. What a model call answering it is about.
 */
export function slackPlace(body: string): Omit<MessagePlace, "channel"> | undefined {
  let parsed: unknown;
  try {
    parsed = body.trim().startsWith("{") ? JSON.parse(body) : JSON.parse(new URLSearchParams(body).get("payload") ?? "");
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const event = isObject(parsed.event) ? parsed.event : undefined;
  if (event) {
    const ts = str(event.ts) ?? str(event.event_ts);
    const from = str(event.user);
    const conversation = str(event.channel);
    const thread = str(event.thread_ts) ?? ts;
    return {
      ...(from === undefined ? {} : { from }),
      ...(conversation === undefined ? {} : { conversation }),
      ...(thread === undefined ? {} : { thread }),
      ...(ts === undefined ? {} : { message: ts }),
    };
  }
  // An interaction: the person who clicked, and the message the button is on.
  const user = isObject(parsed.user) ? str(parsed.user.id) : undefined;
  const channel = isObject(parsed.channel) ? str(parsed.channel.id) : undefined;
  const message = isObject(parsed.message) ? parsed.message : undefined;
  const ts = message ? str(message.ts) : undefined;
  const thread = message ? (str(message.thread_ts) ?? ts) : undefined;
  if (user === undefined && channel === undefined) return undefined;
  return {
    ...(user === undefined ? {} : { from: user }),
    ...(channel === undefined ? {} : { conversation: channel }),
    ...(thread === undefined ? {} : { thread }),
    ...(ts === undefined ? {} : { message: ts }),
  };
}
