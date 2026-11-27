import type {
  App, Delivery, DeliveryAttempt, DeliveryResendOptions, HasTranscript, Inspectable, Principal,
  QuietOptions, Resource, Timestamp, User, WaitOptions,
} from "./common";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** The `twilio` test fixture: the agent's Twilio account and number, and people's phones. */
export interface TwilioFixture extends Inspectable<TwilioDelivery> {
  /** The agent's number, built in as `my-agent`: people text `app.number`. */
  readonly app: TwilioApp;
  /**
   * Where the agent's `twilio` client sends `https://api.twilio.com`: `TWILIO_API_URL`. The SDK has
   * no base-URL setting, so the agent gives it an `httpClient` that rewrites the origin.
   */
  readonly apiUrl: string;

  createUser(options: TwilioUserOptions): Promise<TwilioUser>;
}

export interface TwilioUserOptions {
  name: string;
  /**
   * The person's number, in E.164. Default: one the fake hands out (`+1 NXX 555-01XX`, kept for
   * fiction). Live, a number of the account `token` opens; also read from
   * `CHANNELSTACK_TWILIO_USER_<NAME>_NUMBER`, and left out there, that account's one allowlisted
   * number besides the agent's.
   */
  number?: string;
  /** False for a phone that's off: what the agent sends them ends `undelivered`, error 30003. Fake only. */
  reachable?: boolean;
  /**
   * A real person, live: `<Account SID>:<Auth Token>` of the account that owns their number (the
   * agent's own, or another). Also read from `CHANNELSTACK_TWILIO_USER_<NAME>_TOKEN`.
   */
  token?: string;
}

// ---------------------------------------------------------------------------
// People and the app
// ---------------------------------------------------------------------------

/** The agent's Twilio number. Its `id` is the number's SID (`PN…`). */
export interface TwilioApp extends App {
  readonly channel: "twilio";
  /** Where people text the agent, in E.164. */
  readonly number: string;
}

/** A person: a phone. Their `id` is their number. */
export interface TwilioUser extends User {
  readonly channel: "twilio";
  readonly number: string;

  /**
   * Text someone: the agent (`twilio.app`), or another person. To the agent, Twilio posts it to the
   * agent's webhook; `STOP`, `START` and `HELP` Twilio answers itself too.
   */
  text(body: string, options: { to: TwilioUser | TwilioApp; media?: string[] }): Promise<TwilioMessage>;
  /** What reached the person's phone, oldest first: the agent's answers among it. */
  messages(): Promise<TwilioMessage[]>;
  /** The next text to reach the person, from anyone or from `from`. */
  waitForMessage(options?: { from?: Principal | string } & WaitOptions): Promise<TwilioMessage>;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** What became of a message, as Twilio names it. A person's text to the agent is `received`. */
export type TwilioMessageStatus =
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "undelivered"
  | "failed"
  | "received"
  | "canceled";

/** One text: a person's, or one the agent sent. Its `id` is its SID (`SM…`). */
export interface TwilioMessage extends Resource {
  readonly channel: "twilio";
  /** The conversation between its two numbers. */
  readonly conversation: TwilioConversation;
  /** Who wrote it: a person, the app, or for a number no one in the test has, that number. */
  readonly author: Principal;
  readonly from: string;
  readonly to: string;
  /** What was sent. */
  readonly text: string;
  /** How many SMS segments it was sent in, as Twilio counts them (160 GSM-7 characters, 70 otherwise). */
  readonly segments: number;
  readonly status: TwilioMessageStatus;
  /** Why it wasn't delivered: 30003, a phone that's off. */
  readonly errorCode?: number;
  readonly at: Timestamp;
  /** For a text to the agent: the webhook that told it. Fake mode. */
  readonly delivery?: TwilioDelivery;

  /** Read it again: its status, once Twilio sent it. */
  refresh(): Promise<TwilioMessage>;
}

/** The texts between two numbers: a conversation. Its `id` is its first message's SID. */
export interface TwilioConversation extends Resource, HasTranscript {
  readonly channel: "twilio";
  /** Its two numbers. */
  readonly numbers: readonly string[];

  /** Every message, oldest first. */
  messages(): Promise<TwilioMessage[]>;
  /** The answers: every message after the first, oldest first. */
  replies(): Promise<TwilioMessage[]>;
  /** The next reply, from anyone or from `from`. */
  waitForReply(options?: { from?: Principal | string } & WaitOptions): Promise<TwilioMessage>;
  /** The newest reply once the agent is quiet. */
  latestReply(options?: { from?: Principal | string } & QuietOptions): Promise<TwilioMessage>;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

/** `message`: a text to the agent's number; `status`: a status callback for a message it sent. */
export type TwilioEventType = "message" | "status";

/**
 * A request Twilio sent the agent: form-encoded, signed with `X-Twilio-Signature` (HMAC-SHA1 with
 * the Auth Token over the URL and the sorted parameters). Its `id` is its `I-Twilio-Idempotency-Token`.
 */
export interface TwilioDelivery extends Delivery<TwilioEventType, Readonly<Record<string, string>>> {
  readonly channel: "twilio";
  /** The SID of the message it is about. */
  readonly message: string;

  /** Read it again: its attempts and status. */
  refresh(): Promise<TwilioDelivery>;
  /** Send it again, as Twilio retries: the same request and idempotency token. Its TwiML is acted on too. Fake only. */
  redeliver(): Promise<DeliveryAttempt>;
  resend(options?: DeliveryResendOptions): Promise<DeliveryAttempt>;
}
