/**
 * The Twilio driver's records, for both worlds: the agent's account and number, the people who text
 * it, and every message.
 */

/** The agent's Twilio account and its number. Its id is the number's SID (`PN…`). */
export interface TwilioAppRecord {
  readonly id: string;
  readonly name: string;
  /** The agent's number, in E.164. */
  readonly number: string;
  readonly accountSid: string;
  /** A Messaging Service with the number in its sender pool, for an agent that sends through one. */
  readonly messagingServiceSid: string;
}

/** A person: a phone. Their id is their number. */
export interface TwilioPersonRecord {
  readonly id: string;
  readonly name: string;
  readonly number: string;
  /** False for a phone that's off: what the agent sends them ends `undelivered` (30003). */
  readonly reachable: boolean;
  /** The test chose the number: freed again when its session closes (decision 0006). */
  readonly fixedId: boolean;
}

/** A message's status, as Twilio names them. */
export type TwilioMessageStatus =
  "queued" | "sending" | "sent" | "delivered" | "undelivered" | "failed" | "received" | "canceled";

/** `inbound` to the agent's number, `outbound-api` through the REST API, `outbound-reply` through TwiML. */
export type TwilioDirection = "inbound" | "outbound-api" | "outbound-reply";

export interface TwilioMessageRecord {
  /** Its SID (`SM…`). */
  readonly id: string;
  /** The account it is on: the agent's for what it sends and receives, none for texts between people. */
  readonly accountSid: string | undefined;
  readonly from: string;
  readonly to: string;
  /** What was sent. Empty once the agent redacts it (`messages.update` with an empty `Body`). */
  body: string;
  readonly media: readonly string[];
  readonly segments: number;
  readonly direction: TwilioDirection;
  status: TwilioMessageStatus;
  errorCode: number | undefined;
  /** Who wrote it: a person's id or the app's, or none for a number no one in the test has. */
  readonly author: string | undefined;
  /** Twilio's own answer to `STOP`, `START` or `HELP`: from the agent's number, but not the agent's. */
  readonly automatic: boolean;
  /** The conversation it is in: the id of the first message between its two numbers. */
  readonly conversation: string;
  readonly messagingServiceSid: string | undefined;
  /** Where Twilio tells the agent what became of it. */
  readonly statusCallback: string | undefined;
  readonly createdAt: number;
  sentAt: number | undefined;
  updatedAt: number;
  /** For a text to the agent: the webhook that told it. */
  delivery: string | undefined;
}

/** The messages between two numbers. Its id is its first message's SID. */
export interface TwilioConversationRecord {
  readonly id: string;
  /** Its two numbers, sorted. */
  readonly numbers: readonly [string, string];
  readonly createdAt: number;
}
