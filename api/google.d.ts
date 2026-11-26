import type {
  App, Delivery, DeliveryAttempt, DeliveryResendOptions, HasTranscript, Inspectable, Principal,
  QuietOptions, Resource, Timestamp, User, WaitOptions,
} from "./common";
import type { EmailReplyOptions, EmailSendOptions } from "./email";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * The `google` test fixture: Gmail. The agent's app is a Gmail mailbox it reads and sends from
 * through the Gmail API, told of new mail by Pub/Sub pushes; people are other mailboxes.
 */
export interface GoogleFixture extends Inspectable<GoogleDelivery> {
  /** The agent's mailbox, built in as `my-agent`: people email `app.address`. */
  readonly app: GoogleApp;
  /** The root URL to give the agent's `googleapis` client (`GOOGLE_API_URL`, as `rootUrl`). */
  readonly apiUrl: string;

  createUser(options: GoogleUserOptions): Promise<GoogleUser>;
}

export interface GoogleUserOptions {
  name: string;
  /** The person's address. Default `<name>@example.com`. */
  address?: string;
  /**
   * A real person, live: a refresh token for their own Gmail account, from the same OAuth client
   * as the agent's, which sends as them and reads their mail. Also read from
   * `CHANNELSTACK_GOOGLE_USER_<NAME>_TOKEN`.
   */
  token?: string;
}

// ---------------------------------------------------------------------------
// People and the app
// ---------------------------------------------------------------------------

/** The agent's Gmail mailbox. */
export interface GoogleApp extends App {
  readonly channel: "google";
  /** Where people email the agent: its mailbox's address. */
  readonly address: string;
}

/** A person: a Gmail mailbox. Their `id` is their address. */
export interface GoogleUser extends User {
  readonly channel: "google";
  readonly address: string;

  /** Email someone: the agent (`google.app`), or other people. To the agent, a push tells it. */
  send(options: EmailSendOptions<GoogleUser | GoogleApp>): Promise<GoogleEmail>;
  /** Reply to an email, in its thread. */
  reply(email: GoogleEmail, options?: EmailReplyOptions): Promise<GoogleEmail>;
  /** What reached the person's mailbox, oldest first: the agent's answers among it. */
  inbox(): Promise<GoogleEmail[]>;
  /** The next email to reach the person, from anyone or from `from`. */
  waitForEmail(options?: { from?: Principal | string } & WaitOptions): Promise<GoogleEmail>;
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/** One email: a person's, or one the agent sent. */
export interface GoogleEmail extends Resource {
  readonly channel: "google";
  /** The thread it is in. */
  readonly thread: GoogleThread;
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
  /** Its labels in the agent's mailbox (`INBOX`, `UNREAD`, `SENT`, the agent's own), for an email the agent has. */
  readonly labels: readonly string[];
  /** For an email to the agent: the push that told it. Fake mode. */
  readonly delivery?: GoogleDelivery;

  /** Read it again. */
  refresh(): Promise<GoogleEmail>;
}

/** A conversation, as Gmail threads it. Its `id` is its first email's. */
export interface GoogleThread extends Resource, HasTranscript {
  readonly channel: "google";
  readonly subject: string;

  /** Every email in the thread, oldest first. */
  messages(): Promise<GoogleEmail[]>;
  /** The answers: every email after the first, oldest first. */
  replies(): Promise<GoogleEmail[]>;
  /** The next reply, from anyone or from `from`. */
  waitForReply(options?: { from?: Principal | string } & WaitOptions): Promise<GoogleEmail>;
  /** The newest reply once the agent is quiet. */
  latestReply(options?: { from?: Principal | string } & QuietOptions): Promise<GoogleEmail>;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

/** Gmail's push notifications have one kind: the mailbox's history moved on. */
export type GoogleEventType = "gmail.history";

/**
 * A Pub/Sub push Gmail sent the agent: `{ emailAddress, historyId }` in `message.data`, with an
 * OIDC token in `Authorization` that the agent checks with `verifyIdToken`.
 */
export interface GoogleDelivery extends Delivery<GoogleEventType> {
  readonly channel: "google";
  /** The Pub/Sub message's id. */
  readonly id: string;
  /** The mailbox the push is about. */
  readonly emailAddress: string;
  /** The mailbox's history id when the push was sent: the agent lists history from its last one. */
  readonly historyId: string;

  /** Read it again: its attempts and status. */
  refresh(): Promise<GoogleDelivery>;
  /** Send it again, as Pub/Sub does when a push isn't acknowledged: the same message id. Fake only. */
  redeliver(): Promise<DeliveryAttempt>;
  resend(options?: GoogleDeliveryResendOptions): Promise<DeliveryAttempt>;
}

export interface GoogleDeliveryResendOptions extends DeliveryResendOptions {
  /** With a token that has expired. The agent should reject it. */
  stale?: boolean;
  /** With a token for another audience than the agent's push endpoint. The agent should reject it. */
  wrongAudience?: boolean;
}
