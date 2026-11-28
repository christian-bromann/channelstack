import { placeFrom } from "../../core/attribution/place.ts";
import type { MessagePlace } from "../../core/router/index.ts";

/** Where the message a delivery tells the agent about is (a Discord Gateway dispatch or interaction: its author, the channel, and the message): what a model call answering it is about. */
export const discordPlace = (body: string): Omit<MessagePlace, "channel"> | undefined =>
  placeFrom(body, {
    from: ["d.author.id", "member.user.id", "user.id"],
    conversation: ["d.channel_id", "channel_id", "channel.id"],
    thread: ["d.channel_id", "channel_id"],
    message: ["d.id", "message.id"],
  });
