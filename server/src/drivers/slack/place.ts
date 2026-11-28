import { placeFrom } from "../../core/attribution/place.ts";
import type { MessagePlace } from "../../core/router/index.ts";

/**
 * Where the message a Slack delivery tells the agent about is: an Events API callback has it in its
 * `event`; an interaction (a click) in its form's `payload`. What a model call answering it is about.
 */
export const slackPlace = (body: string): Omit<MessagePlace, "channel"> | undefined =>
  placeFrom(body, {
    from: ["event.user", "user.id"],
    conversation: ["event.channel", "channel.id"],
    thread: ["event.thread_ts", "event.ts", "message.thread_ts", "message.ts"],
    message: ["event.ts", "event.event_ts", "message.ts"],
  });
