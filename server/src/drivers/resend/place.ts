import { placeFrom } from "../../core/attribution/place.ts";
import type { MessagePlace } from "../../core/router/index.ts";

/** Where the message a delivery tells the agent about is (a Resend webhook: the sender's address (a person is their mailbox), and the email): what a model call answering it is about. */
export const resendPlace = (body: string): Omit<MessagePlace, "channel"> | undefined =>
  placeFrom(body, {
    from: ["data.from"],
    conversation: [],
    thread: [],
    message: ["data.email_id"],
  });
