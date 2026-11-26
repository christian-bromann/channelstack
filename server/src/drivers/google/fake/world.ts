import { deliveryKit } from "../../../core/delivery/kit.ts";
import {
  emailAuthor,
  localPartOf,
  type Mailbox,
  messageId,
  parseAddresses,
  replyOf,
  threadOf,
} from "../../../core/email/index.ts";
import { composeMime, mimeHeaders, parseMime } from "../../../core/email/mime.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { GOOGLE_IDS } from "../ids.ts";
import { googlePayloads } from "../payloads.ts";
import { GOOGLE_SECRETS } from "../secrets.ts";
import { keyIdOf, PUSH_TOKEN_LIFETIME_S, signPushToken } from "../signing.ts";
import type { GmailHistoryRecord, GmailMessageRecord, GoogleEmailRecord, GoogleUserRecord } from "../world.ts";
import type { GoogleStore } from "./store.ts";

/** Gmail's own mail servers name the `Message-ID`s of what they send. */
const GMAIL_DOMAIN = "mail.gmail.com";
/** Pub/Sub's ack deadline: also how long a push waits for the endpoint's answer. */
const ACK_DEADLINE_MS = 10_000;
/** Pub/Sub's push backoff after an unacknowledged push: from 100 milliseconds up to a minute. */
const PUSH_BACKOFF_MS = [100, 200, 400, 800, 1_600, 3_200, 6_400, 12_800, 25_600, 51_200, 60_000, 60_000];
/** Gmail pushes at most once a second per mailbox (decision 0022: held, per session). */
const PUSH_INTERVAL_MS = 1000;
/** A token past its hour and the five minutes' skew `verifyIdToken` allows. */
const EXPIRED_MS = 2 * PUSH_TOKEN_LIFETIME_S * 1000;
/** A `watch` lasts seven days. */
const WATCH_MS = 7 * 24 * 3_600_000;
/** What labels a message that reaches the agent gets. */
const RECEIVED_LABELS = ["UNREAD", "CATEGORY_PERSONAL", "INBOX"];

/** The fake's Pub/Sub: the topic the agent watches with, its push subscription, and who pushes. */
export const PUBSUB = {
  topic: "projects/channelstack-fake/topics/gmail",
  subscription: "projects/channelstack-fake/subscriptions/gmail-push",
  serviceAccount: "gmail-push@channelstack-fake.iam.gserviceaccount.com",
} as const;

/** Gmail refusing the agent's call: its status, message, reason and gRPC status. */
export class GmailApiError extends Error {
  readonly code: number;
  readonly reason: string;
  readonly status: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: number, message: string, reason: string, status: string, headers: Record<string, string> = {}) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.status = status;
    this.headers = headers;
  }
}

export const notFound = () => new GmailApiError(404, "Requested entity was not found.", "notFound", "NOT_FOUND");
export const invalid = (message: string) => new GmailApiError(400, message, "invalidArgument", "INVALID_ARGUMENT");

/** A subject as Gmail compares them to thread mail: without `Re:` and `Fwd:`, case and spacing folded. */
const threadSubject = (subject: string) =>
  subject
    .replace(/^(\s*(re|fwd?|aw|wg)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** What a person writes in an email. */
export interface PersonMessage {
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly references?: readonly string[];
}

export function createFakeWorld(context: DriverContext, store: GoogleStore) {
  const { ids, clock, timers } = context;
  const keyId = () => keyIdOf(context.secret("pushKey"));
  const pushAccount = ids.next(GOOGLE_IDS.account);
  const claims = (audience: string, atMs: number) => ({
    audience,
    email: PUBSUB.serviceAccount,
    subject: pushAccount,
    atMs,
  });

  /** Gmail's pushes, through Pub/Sub: an OIDC token for the push endpoint, retried on Pub/Sub's backoff. */
  const deliveries = deliveryKit(context, {
    driver: "google",
    timeoutMs: ACK_DEADLINE_MS,
    retry: {
      next: (_attempt, retries) => {
        const afterMs = PUSH_BACKOFF_MS[retries];
        return afterMs === undefined ? undefined : { afterMs, headers: {} };
      },
    },
    sign: (secret, _body, atMs) => ({
      "user-agent": "APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)",
      ...signPushToken(secret, keyId(), claims(context.webhookUrl ?? "", atMs)),
    }),
    secret: () => context.secret("pushKey"),
    // Another key, but the same `kid`: a token that fails its signature check.
    forgedSecret: () => GOOGLE_SECRETS.pushKey.generate(),
    staleMs: EXPIRED_MS,
  });

  // --- History and pushes -----------------------------------------------------------------------

  /** When each session's last push went, and the push held until its second is over. */
  const lastPush = new Map<string, number>();
  const held = new Map<string, () => void>();
  /** The emails whose copies changed since the session's last push: the next push tells of them. */
  const untold = new Map<string, Set<string>>();

  /** Whether a change to a message with these labels is one the agent's watch asked for. */
  const watched = (labels: readonly string[]) => {
    const watch = store.watch;
    if (!watch || watch.expiration < clock()) return false;
    if (watch.labelIds.length === 0) return true;
    const matches = labels.some((label) => watch.labelIds.includes(label));
    return watch.behavior === "include" ? matches : !matches;
  };

  const push = (session: string) => {
    lastPush.set(session, clock());
    const emails = untold.get(session) ?? new Set<string>();
    untold.delete(session);
    if (context.webhookUrl === undefined) return;
    const id = ids.next(GOOGLE_IDS.pushMessage);
    const notification = { emailAddress: store.app.address, historyId: store.historyId };
    const payload = googlePayloads.push(notification, id, new Date(clock()).toISOString(), PUBSUB.subscription);
    deliveries.send({
      id,
      session,
      type: "gmail.history",
      url: context.webhookUrl,
      body: JSON.stringify(payload),
      meta: { payload, ...notification, emails: [...emails] },
    });
    for (const email of emails) {
      const record = store.emails.find(email);
      if (record && record.delivery === undefined) record.delivery = id;
    }
  };

  /** The agent's mailbox changed for `session`: push now, or when the session's second is over. */
  const changed = (session: string | undefined, email: string, labels: readonly string[]) => {
    if (session === undefined || !watched(labels)) return;
    let pending = untold.get(session);
    if (!pending) untold.set(session, (pending = new Set()));
    pending.add(email);
    if (held.has(session)) return;
    const since = clock() - (lastPush.get(session) ?? Number.NEGATIVE_INFINITY);
    if (since >= PUSH_INTERVAL_MS) return push(session);
    const wait = PUSH_INTERVAL_MS - since;
    context.expectMore(session, "a Gmail push", wait);
    held.set(
      session,
      timers.after(wait, () => {
        held.delete(session);
        context.arrived(session, "a Gmail push");
        push(session);
      }),
    );
  };

  /**
   * The mailbox's next history id: larger than the last, with a gap, as Gmail's are. The gap
   * varies with the count (7 to 19), not with a draw: ids drawn must be unique, gaps needn't be.
   */
  const nextHistoryId = () => {
    const count = ids.sequence("google.history");
    store.historyId = String(BigInt(store.historyId) + BigInt(7 + ((count * count) % 13)));
    return store.historyId;
  };

  /** Record a change to a message of the agent's mailbox, and tell the agent if it watches for it. */
  const record = (
    message: GmailMessageRecord,
    kind: GmailHistoryRecord["kind"],
    labels: readonly string[],
    labelsBefore: readonly string[],
  ) => {
    const id = nextHistoryId();
    message.historyId = id;
    const session = store.messages.owner(message.id);
    store.history.add(
      id,
      { id, kind, message: message.id, threadId: message.threadId, labels, labelsAfter: [...message.labels] },
      session,
    );
    changed(session, message.email, [...labelsBefore, ...message.labels]);
  };

  // --- The agent's mailbox ----------------------------------------------------------------------

  /** The Gmail thread a message joins in the agent's mailbox: one whose message it names, with its subject. */
  const gmailThreadFor = (email: GoogleEmailRecord, wanted?: string) => {
    const subject = threadSubject(email.subject);
    const named = new Set([...(email.inReplyTo ? [email.inReplyTo] : []), ...email.references]);
    const candidates = wanted !== undefined ? [wanted] : store.gmailThreads.values().map((thread) => thread.id);
    for (const id of candidates) {
      const thread = store.gmailThreads.find(id);
      if (!thread || thread.subject !== subject) continue;
      const referenced = store.messagesIn(id).some((message) => {
        const copy = store.emails.find(message.email);
        return copy !== undefined && named.has(copy.messageId);
      });
      if (referenced) return id;
    }
    return undefined;
  };

  /** Put a copy of `email` into the agent's mailbox, with `labels`, in the thread Gmail would put it in. */
  const intoMailbox = (email: GoogleEmailRecord, labels: string[], session: string | undefined, threadId?: string) => {
    const joined = gmailThreadFor(email, threadId);
    const thread = joined ?? ids.next(GOOGLE_IDS.thread);
    if (joined === undefined) {
      store.gmailThreads.add(thread, { id: thread, subject: threadSubject(email.subject) }, session);
    }
    const message: GmailMessageRecord = {
      // The sender's copy keeps the email's id; a copy that reaches the agent gets its own.
      id: email.author === store.app.id ? email.id : ids.next(GOOGLE_IDS.message),
      email: email.id,
      threadId: thread,
      labels,
      historyId: store.historyId,
      internalDate: email.createdAt,
    };
    store.messages.add(message.id, message, session);
    email.agentCopy = message.id;
    record(message, "messageAdded", [], []);
    return message;
  };

  /** Keep an email, and the conversation it starts. */
  const keep = (email: GoogleEmailRecord, session: string | undefined) => {
    if (email.thread === email.id) {
      store.threads.add(email.id, { id: email.id, subject: email.subject, createdAt: email.createdAt }, session);
    }
    return store.emails.add(email.id, email, session);
  };

  const conversationOf = (message: { id: string; inReplyTo?: string | undefined; references: readonly string[] }) =>
    threadOf(message, (id) => store.byMessageId(id)?.thread) ?? message.id;

  const isApp = (mailbox: Mailbox) => mailbox.address === store.app.address;

  return {
    store,
    isApp,
    principalOf: (email: GoogleEmailRecord) => emailAuthor(email, store.app, (id) => store.users.find(id)),
    /** The id of the key the certificates serve. */
    keyId,

    /** A person: a mailbox at `<name>@example.com` unless the test gives an address. Their id is their address. */
    createUser(session: string, input: { name: string; address?: string | undefined }): GoogleUserRecord {
      let address = input.address?.toLowerCase();
      if (address !== undefined) {
        if (parseAddresses(address)[0]?.address !== address) {
          throw new ProtocolError("invalid_argument", `"${input.address}" is not an email address`);
        }
        if (store.personAt(address) || address === store.app.address) {
          throw new ProtocolError("invalid_argument", `Someone has the address ${address} already`);
        }
      } else {
        const local = localPartOf(input.name);
        address = `${local}@example.com`;
        for (let n = 2; store.personAt(address); n++) address = `${local}${n}@example.com`;
      }
      return store.users.add(address, { id: address, name: input.name, address, fixedId: false }, session);
    },

    /**
     * A person sends an email from their Gmail mailbox. To the agent's address, a copy lands in the
     * agent's inbox, unread, and its watch hears of it; to anyone else it stays in the outside world.
     */
    async personSends(session: string, person: GoogleUserRecord, input: PersonMessage): Promise<GoogleEmailRecord> {
      const id = ids.next(GOOGLE_IDS.message);
      const at = clock();
      const references = input.references ?? [];
      const message = {
        from: { address: person.address, name: person.name },
        to: input.to,
        cc: input.cc,
        bcc: [],
        replyTo: [],
        subject: input.subject,
        text: input.text,
        html: input.html,
        messageId: messageId(ids.next(GOOGLE_IDS.messageLocal), GMAIL_DOMAIN),
        inReplyTo: input.inReplyTo,
        references,
      };
      const raw = await composeMime(message, at);
      const email: GoogleEmailRecord = {
        ...message,
        id,
        author: person.id,
        thread: conversationOf({ id, inReplyTo: input.inReplyTo, references }),
        createdAt: at,
        raw,
        headers: mimeHeaders(raw),
        agentCopy: undefined,
        delivery: undefined,
      };
      keep(email, session);
      if ([...input.to, ...input.cc].some(isApp)) intoMailbox(email, [...RECEIVED_LABELS], session);
      return email;
    },

    /** A person replies to an email: to its sender (and everyone on it, with `all`), in its thread. */
    personReplies(
      session: string,
      person: GoogleUserRecord,
      to: GoogleEmailRecord,
      input: { text: string | undefined; html: string | undefined; all: boolean },
    ): Promise<GoogleEmailRecord> {
      return this.personSends(session, person, {
        ...replyOf(person, to, input.all),
        text: input.text,
        html: input.html,
      });
    },

    /**
     * The agent sends a message (`users.messages.send`): the RFC 5322 message it wrote, from its own
     * address. It joins `threadId` in its mailbox when that thread's subject matches and the message
     * names one of its messages, as Gmail threads; each recipient gets it.
     */
    async appSends(raw: string, threadId: string | undefined): Promise<GmailMessageRecord> {
      if (threadId !== undefined && !store.gmailThreads.find(threadId)) throw notFound();
      const parsed = await parseMime(raw);
      const to = [...parsed.to, ...parsed.cc, ...parsed.bcc];
      if (to.length === 0) {
        throw new GmailApiError(400, "Recipient address required", "invalidArgument", "INVALID_ARGUMENT");
      }
      const id = ids.next(GOOGLE_IDS.message);
      // Gmail sends as the account: a From it doesn't own becomes the account's address.
      const from =
        parsed.from.address === store.app.address ? parsed.from : { address: store.app.address, name: store.app.name };
      const ownId = parsed.messageId || messageId(ids.next(GOOGLE_IDS.messageLocal), GMAIL_DOMAIN);
      // The email belongs to the session of the conversation it answers, or of a person it reaches.
      const answered = threadOf(parsed, (named) => store.byMessageId(named)?.thread);
      const reached = to.map((mailbox) => store.personAt(mailbox.address)).find(Boolean);
      const session =
        answered !== undefined
          ? store.threads.owner(answered)
          : reached === undefined
            ? undefined
            : store.users.owner(reached.id);
      const email: GoogleEmailRecord = {
        id,
        author: store.app.id,
        from,
        to: parsed.to,
        cc: parsed.cc,
        bcc: parsed.bcc,
        replyTo: parsed.replyTo,
        subject: parsed.subject,
        text: parsed.text,
        html: parsed.html,
        messageId: ownId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        thread: answered ?? id,
        createdAt: clock(),
        raw,
        headers: parsed.headers,
        agentCopy: undefined,
        delivery: undefined,
      };
      keep(email, session);
      return intoMailbox(email, ["SENT"], session, threadId);
    },

    /** Add and remove labels on a message of the agent's mailbox, as `users.messages.modify` does. */
    modify(message: GmailMessageRecord, add: readonly string[], remove: readonly string[]): GmailMessageRecord {
      for (const label of [...add, ...remove]) {
        if (!store.labels.has(label)) throw invalid(`Invalid label: ${label}`);
        if (label === "SENT" || label === "DRAFT") throw invalid(`Invalid label: ${label}`);
      }
      const before = [...message.labels];
      const added = add.filter((label) => !message.labels.includes(label));
      const removed = remove.filter((label) => message.labels.includes(label) && !add.includes(label));
      message.labels = [...message.labels.filter((label) => !removed.includes(label)), ...added];
      if (added.length > 0) record(message, "labelAdded", added, before);
      if (removed.length > 0) record(message, "labelRemoved", removed, before);
      return message;
    },

    /** The agent watches its mailbox: Gmail pushes its changes to the fake's topic from now on. */
    watch(input: { topicName: string; labelIds: readonly string[]; behavior: "include" | "exclude" }) {
      if (input.topicName !== PUBSUB.topic) {
        throw new GmailApiError(
          403,
          `Error sending test message to Cloud PubSub ${input.topicName} : User not authorized to perform this action.`,
          "forbidden",
          "PERMISSION_DENIED",
        );
      }
      store.watch = { ...input, expiration: clock() + WATCH_MS };
      return { historyId: store.historyId, expiration: String(store.watch.expiration) };
    },

    stop() {
      store.watch = undefined;
    },

    /** What reached a person, oldest first. */
    inbox: (person: GoogleUserRecord) => store.mailTo(person.address),

    /** The email a message of the agent's mailbox is a copy of. */
    emailOf(message: GmailMessageRecord): GoogleEmailRecord {
      const email = store.emails.find(message.email);
      if (!email) throw notFound();
      return email;
    },

    /** Send a push again, forged: signed by another key, with an expired token, or for another audience. */
    resend(session: string, id: string, options: { badSignature: boolean; stale?: boolean; wrongAudience?: boolean }) {
      if (options.wrongAudience) {
        return deliveries.resend(session, id, {
          forge: (_body, atMs) =>
            signPushToken(context.secret("pushKey"), keyId(), claims("https://example.com/not-the-agent", atMs)),
        });
      }
      return deliveries.resend(session, id, options);
    },
    redeliver: (session: string, id: string) => deliveries.redeliver(session, id),
    deliveries: deliveries.deliveries,
    delivery: deliveries.delivery,

    /** A session closed: its held push goes with it. */
    release(session: string) {
      held.get(session)?.();
      held.delete(session);
      lastPush.delete(session);
      untold.delete(session);
    },
  };
}

export type FakeGoogleWorld = ReturnType<typeof createFakeWorld>;
