import type {
  App, Delivery, DeliveryAttempt, DeliveryResendOptions, HasTranscript, Inspectable, Principal,
  QuietOptions, Resource, Timestamp, User, WaitOptions,
} from "./common";
import type { EmailReplyOptions, EmailSendOptions } from "./email";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** The `resend` test fixture: the agent's team (one verified domain that sends and receives), and people's mailboxes. */
export interface ResendFixture extends Inspectable<ResendDelivery> {
  /** The agent's team, built in as `my-agent`: people email `app.address`. */
  readonly app: ResendApp;
  /** Base URL to give the agent: `RESEND_BASE_URL`, which the `resend` SDK reads. */
  readonly apiUrl: string;

  createUser(options: ResendUserOptions): Promise<ResendUser>;
}

export interface ResendUserOptions {
  name: string;
  /** The person's address. Default `<name>@example.com`. */
  address?: string;
  /**
   * A real person, live: an API key of their own Resend team, which sends as them and reads what
   * reaches their address. Also read from `CHANNELSTACK_RESEND_USER_<NAME>_TOKEN`.
   */
  token?: string;
}

// ---------------------------------------------------------------------------
// People and the app
// ---------------------------------------------------------------------------

export type ResendPrincipal = ResendUser | ResendApp;

/** The agent's team. */
export interface ResendApp extends App {
  readonly channel: "resend";
  /** Where people email the agent: the team's receiving address. */
  readonly address: string;
}

/** A person: a mailbox. Their `id` is their address. */
export interface ResendUser extends User {
  readonly channel: "resend";
  readonly address: string;

  /** Email someone: the agent (`resend.app`), or other people. To the agent, it arrives as `email.received`. */
  send(options: EmailSendOptions<ResendPrincipal>): Promise<ResendEmail>;
  /** Reply to an email, in its thread. */
  reply(email: ResendEmail, options?: EmailReplyOptions): Promise<ResendEmail>;
  /** What reached the person's mailbox, oldest first: the agent's answers among it. */
  inbox(): Promise<ResendEmail[]>;
  /** The next email to reach the person, from anyone or from `from`. */
  waitForEmail(options?: { from?: Principal | string } & WaitOptions): Promise<ResendEmail>;
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/** One email: a person's, or one the agent sent. */
export interface ResendEmail extends Resource {
  readonly channel: "resend";
  /** The thread it is in. */
  readonly thread: ResendThread;
  /** Who wrote it: a person, the app, or for an address no one in the test has, that address. */
  readonly author: Principal;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  /** What its writer wrote, without the quoted history a reply carries. */
  readonly text: string;
  readonly at: Timestamp;
  /** Its `Message-ID` header. */
  readonly messageId: string;
  /** For an email to the agent: the `email.received` webhook that told it. Fake mode. */
  readonly delivery?: ResendDelivery;

  /** Read it again. */
  refresh(): Promise<ResendEmail>;
}

/** Emails joined by `In-Reply-To` and `References`: a conversation. Its `id` is its first email's. */
export interface ResendThread extends Resource, HasTranscript {
  readonly channel: "resend";
  readonly subject: string;

  /** Every email in the thread, oldest first. */
  messages(): Promise<ResendEmail[]>;
  /** The answers: every email after the first, oldest first. */
  replies(): Promise<ResendEmail[]>;
  /** The next reply, from anyone or from `from`. */
  waitForReply(options?: { from?: Principal | string } & WaitOptions): Promise<ResendEmail>;
  /** The newest reply once the agent is quiet. */
  latestReply(options?: { from?: Principal | string } & QuietOptions): Promise<ResendEmail>;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export type ResendEventType =
  | "email.received"
  | "email.sent"
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.bounced"
  | "email.complained"
  | "email.suppressed";

/** A webhook Resend sent the agent, signed the way Svix signs (`svix-id`, `svix-timestamp`, `svix-signature`). */
export interface ResendDelivery extends Delivery<ResendEventType> {
  readonly channel: "resend";
  /** The email the event is about. */
  readonly email: string;

  /** Read it again: its attempts and status. */
  refresh(): Promise<ResendDelivery>;
  /** Send it again, as Resend retries: the same `svix-id`, signed again. Fake only. */
  redeliver(): Promise<DeliveryAttempt>;
  resend(options?: ResendDeliveryResendOptions): Promise<DeliveryAttempt>;
}

export interface ResendDeliveryResendOptions extends DeliveryResendOptions {
  /** Signed with a timestamp past the five minutes receivers accept. The agent should reject it. */
  stale?: boolean;
}
