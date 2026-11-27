import { BUILT_IN_APP } from "../../../core/apps/index.ts";
import { deliveryKit } from "../../../core/delivery/kit.ts";
import { emailAuthor, formatMailbox, type Mailbox, messageId, replyOf, threadOf } from "../../../core/email/index.ts";
import { composeMime, mimeHeaders, ownHeaders, parseMime, withHeaders } from "../../../core/email/mime.ts";
import type { EmailAppMessageInput, EmailMessageInput } from "../../../core/email/routes.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { GOOGLE_IDS } from "../ids.ts";
import { googlePayloads } from "../payloads.ts";
import { GOOGLE_SECRETS } from "../secrets.ts";
import { keyIdOf, PUSH_TOKEN_LIFETIME_S, signPushToken } from "../signing.ts";
import type {
  GmailHistoryRecord,
  GmailMessageRecord,
  GoogleAppRecord,
  GoogleEmailRecord,
  GoogleUserRecord,
} from "../world.ts";
import type { GmailMailbox, GoogleStore } from "./store.ts";

/** Gmail's own mail servers name the `Message-ID`s of what they send. */
const GMAIL_DOMAIN = "mail.gmail.com";
/** The Workspace domain every app's mailbox is at: one domain holds many mailboxes. */
const WORKSPACE_DOMAIN = "acme.example";
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
/** What labels a message that reaches a mailbox gets. */
const RECEIVED_LABELS = ["UNREAD", "CATEGORY_PERSONAL", "INBOX"];

/** The fake's Pub/Sub: the topic the agent watches with, its push subscription, and who pushes. */
export const PUBSUB = {
  topic: "projects/channelstack-fake/topics/gmail",
  subscription: "projects/channelstack-fake/subscriptions/gmail-push",
  serviceAccount: "gmail-push@channelstack-fake.iam.gserviceaccount.com",
} as const;

/** An app's own topic and push subscription: the built-in app's are `PUBSUB`'s, another's carry its name. */
export function pubsubOf(app: string): { topic: string; subscription: string } {
  if (app === BUILT_IN_APP) return PUBSUB;
  return { topic: `${PUBSUB.topic}-${app}`, subscription: `${PUBSUB.subscription}-${app}` };
}

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

/** What a person writes in an email: the email core's, and what it answers. */
type PersonMessage = EmailMessageInput & {
  readonly inReplyTo?: string | undefined;
  readonly references?: readonly string[];
};

export function createFakeWorld(context: DriverContext, store: GoogleStore) {
  const { ids, clock, timers } = context;
  const keyId = () => keyIdOf(context.secret("pushKey"));
  const pushAccount = ids.next(GOOGLE_IDS.account);
  /** A push's headers, as Pub/Sub sends them: its user agent, and a token for `audience` signed with `key`. */
  const pushHeaders = (key: string, audience: string, atMs: number) => ({
    "user-agent": "APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)",
    ...signPushToken(key, keyId(), { audience, email: PUBSUB.serviceAccount, subject: pushAccount, atMs }),
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
    // Google signs every push with its own key; each app's push endpoint is its audience.
    sign: (secret, _body, atMs, { url }) => pushHeaders(secret, url, atMs),
    secret: () => context.secret("pushKey"),
    // Another key, but the same `kid`: a token that fails its signature check.
    forgedSecret: () => GOOGLE_SECRETS.pushKey.generate(),
    staleMs: EXPIRED_MS,
  });

  const mailboxOf = (app: GoogleAppRecord): GmailMailbox => store.mailbox(app.name);
  const appNamed = (name: string): GoogleAppRecord => store.apps.named(name) ?? store.app;

  // --- History and pushes -----------------------------------------------------------------------

  /** Pushes are per mailbox and session: when each last went, the one held until its second is over. */
  const key = (app: GoogleAppRecord, session: string) => `${app.name}\u0000${session}`;
  const lastPush = new Map<string, number>();
  const held = new Map<string, () => void>();
  /** The emails whose copies changed since the mailbox's last push in the session: the next push tells of them. */
  const untold = new Map<string, Set<string>>();

  /** Whether a change to a message with these labels is one the app's watch asked for. */
  const watched = (app: GoogleAppRecord, labels: readonly string[]) => {
    const { watch } = mailboxOf(app);
    if (!watch || watch.expiration < clock()) return false;
    if (watch.labelIds.length === 0) return true;
    const matches = labels.some((label) => watch.labelIds.includes(label));
    return watch.behavior === "include" ? matches : !matches;
  };

  const isAt = (app: GoogleAppRecord) => (mailbox: Mailbox) => mailbox.address === app.address;

  const push = (app: GoogleAppRecord, session: string) => {
    const at = key(app, session);
    lastPush.set(at, clock());
    const emails = untold.get(at) ?? new Set<string>();
    untold.delete(at);
    const url = context.apps.webhookUrl(app.name);
    if (url === undefined) return;
    const id = ids.next(GOOGLE_IDS.pushMessage);
    const notification = { emailAddress: app.address, historyId: mailboxOf(app).historyId };
    const payload = googlePayloads.push(
      notification,
      id,
      new Date(clock()).toISOString(),
      pubsubOf(app.name).subscription,
    );
    deliveries.send({
      id,
      session,
      type: "gmail.history",
      url,
      app: app.name,
      body: JSON.stringify(payload),
      meta: { payload, ...notification, emails: [...emails] },
    });
    // The push that told the agent of an email to it (the agent's own sent mail it hears of is no such email).
    if (app !== store.app) return;
    for (const email of emails) {
      const record = store.emails.find(email);
      const toAgent = record !== undefined && [...record.to, ...record.cc, ...record.bcc].some(isAt(app));
      if (record && toAgent && record.delivery === undefined) record.delivery = id;
    }
  };

  /** An app's mailbox changed for `session`: push now, or when the mailbox's second is over. */
  const changed = (app: GoogleAppRecord, session: string | undefined, email: string, labels: readonly string[]) => {
    if (session === undefined || !watched(app, labels)) return;
    const at = key(app, session);
    const pending = untold.get(at) ?? new Set<string>();
    untold.set(at, pending);
    pending.add(email);
    if (held.has(at)) return;
    const since = clock() - (lastPush.get(at) ?? Number.NEGATIVE_INFINITY);
    if (since >= PUSH_INTERVAL_MS) return push(app, session);
    const wait = PUSH_INTERVAL_MS - since;
    const what = app === store.app ? "a Gmail push" : `a Gmail push to ${app.name}`;
    context.expectMore(session, what, wait);
    held.set(
      at,
      timers.after(wait, () => {
        held.delete(at);
        context.arrived(session, what);
        push(app, session);
      }),
    );
  };

  /**
   * A mailbox's next history id: larger than its last, with a gap, as Gmail's are. The gap varies
   * with the count (7 to 19), not with a draw: ids drawn must be unique, gaps needn't be.
   */
  const nextHistoryId = (mailbox: GmailMailbox) => {
    const count = ids.sequence("google.history");
    mailbox.historyId = String(BigInt(mailbox.historyId) + BigInt(7 + ((count * count) % 13)));
    return mailbox.historyId;
  };

  /** Record a change to a message of a mailbox, and tell its app if it watches for it. */
  const record = (
    message: GmailMessageRecord,
    kind: GmailHistoryRecord["kind"],
    labels: readonly string[],
    labelsBefore: readonly string[],
  ) => {
    const app = appNamed(message.mailbox);
    const id = nextHistoryId(mailboxOf(app));
    message.historyId = id;
    const session = store.messages.owner(message.id);
    store.history.add(
      `${message.mailbox}/${id}`,
      {
        id,
        mailbox: message.mailbox,
        kind,
        message: message.id,
        threadId: message.threadId,
        labels,
        labelsAfter: [...message.labels],
      },
      session,
    );
    changed(app, session, message.email, [...labelsBefore, ...message.labels]);
  };

  // --- The mailboxes ----------------------------------------------------------------------------

  /** The Gmail thread a message joins in an app's mailbox: one of its own whose message it names, with its subject. */
  const gmailThreadFor = (email: GoogleEmailRecord, app: GoogleAppRecord, wanted?: string) => {
    const subject = threadSubject(email.subject);
    const named = new Set([...(email.inReplyTo ? [email.inReplyTo] : []), ...email.references]);
    const candidates = wanted !== undefined ? [wanted] : store.gmailThreads.values().map((thread) => thread.id);
    for (const id of candidates) {
      const thread = store.gmailThreads.find(id);
      if (!thread || thread.mailbox !== app.name || thread.subject !== subject) continue;
      const referenced = store.messagesIn(id).some((message) => {
        const copy = store.emails.find(message.email);
        return copy !== undefined && named.has(copy.messageId);
      });
      if (referenced) return id;
    }
    return undefined;
  };

  /** Put a copy of `email` into an app's mailbox, with `labels`, in the thread Gmail would put it in. */
  const intoMailbox = (
    email: GoogleEmailRecord,
    app: GoogleAppRecord,
    labels: string[],
    session: string | undefined,
    threadId?: string,
  ) => {
    // Mail that arrives joins a thread by its references and subject. What the account sends joins
    // one only when it names the thread (`threadId`), as Gmail's threading guide says.
    const sent = email.author === app.id;
    const joined = sent && threadId === undefined ? undefined : gmailThreadFor(email, app, threadId);
    const thread = joined ?? ids.next(GOOGLE_IDS.thread);
    if (joined === undefined) {
      store.gmailThreads.add(thread, { id: thread, mailbox: app.name, subject: threadSubject(email.subject) }, session);
    }
    const message: GmailMessageRecord = {
      // The sender's copy keeps the email's id; a copy that reaches another mailbox gets its own.
      id: sent ? email.id : ids.next(GOOGLE_IDS.message),
      mailbox: app.name,
      email: email.id,
      threadId: thread,
      labels,
      historyId: mailboxOf(app).historyId,
      internalDate: email.createdAt,
    };
    store.messages.add(message.id, message, session);
    if (app === store.app) email.agentCopy = message.id;
    record(message, "messageAdded", [], []);
    return message;
  };

  /** A copy of an email that reaches every app's mailbox it is to, but the sender's. */
  const deliverTo = (email: GoogleEmailRecord, session: string | undefined, sender?: GoogleAppRecord) => {
    for (const app of store.appsAmong([...email.to, ...email.cc, ...email.bcc])) {
      if (app !== sender) intoMailbox(email, app, [...RECEIVED_LABELS], session);
    }
  };

  const conversationOf = (message: { id: string; inReplyTo?: string | undefined; references: readonly string[] }) =>
    threadOf(message, (id) => store.byMessageId(id)?.thread) ?? message.id;

  const isApp = (mailbox: Mailbox) => store.appAt(mailbox.address) !== undefined;

  /** Another app's mailbox (`createApp`): `<name>@acme.example`, its own OAuth client and history. */
  const createApp = (session: string | undefined, input: { name: string }): GoogleAppRecord => {
    let historyStart: string | undefined;
    const app = store.makeApp(session, input.name, {}, () => {
      const appIds = context.apps.ids(input.name);
      historyStart = appIds.next(GOOGLE_IDS.history);
      return { id: appIds.next(GOOGLE_IDS.account), name: input.name, address: `${input.name}@${WORKSPACE_DOMAIN}` };
    });
    if (historyStart !== undefined) store.mailbox(app.name, historyStart);
    return app;
  };

  /**
   * An app sends a message (`users.messages.send`): the RFC 5322 message it wrote, from its own
   * address. It joins `threadId` in its mailbox when that thread's subject matches and the message
   * names one of its messages, as Gmail threads; each recipient gets it, an app's mailbox a copy of
   * its own. A test acting as an app it made sends it in its `session`.
   */
  const appSends = async (
    raw: string,
    threadId: string | undefined,
    app: GoogleAppRecord,
    acting?: string,
  ): Promise<GmailMessageRecord> => {
    if (threadId !== undefined && store.gmailThreads.find(threadId)?.mailbox !== app.name) throw notFound();
    const parsed = await parseMime(raw);
    const to = [...parsed.to, ...parsed.cc, ...parsed.bcc];
    if (to.length === 0) {
      throw new GmailApiError(400, "Recipient address required", "invalidArgument", "INVALID_ARGUMENT");
    }
    const id = ids.next(GOOGLE_IDS.message);
    // Gmail sends as the account: a From it doesn't own becomes the account's address.
    const from = parsed.from.address === app.address ? parsed.from : { address: app.address, name: app.name };
    const ownId = parsed.messageId || messageId(ids.next(GOOGLE_IDS.messageLocal), GMAIL_DOMAIN);
    // What Gmail keeps and sends is the message with the From and the Message-ID it gave it.
    const stamped = {
      ...(from === parsed.from ? {} : { From: formatMailbox(from) }),
      ...(parsed.messageId ? {} : { "Message-ID": ownId }),
    };
    const sent = Object.keys(stamped).length === 0 ? raw : withHeaders(raw, stamped);
    // The email belongs to the session of the conversation it answers, or of a person it reaches.
    const place = store.placeOf(parsed, to);
    const session = acting ?? place.session;
    const email: GoogleEmailRecord = {
      id,
      author: app.id,
      from,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      replyTo: parsed.replyTo,
      subject: parsed.subject,
      text: parsed.text,
      html: parsed.html,
      // Kept in its raw message, which the agent reads back; the record lists none yet (#89).
      attachments: [],
      messageId: ownId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      thread: place.thread ?? id,
      createdAt: clock(),
      raw: sent,
      headers: sent === raw ? parsed.headers : mimeHeaders(sent),
      agentCopy: undefined,
      delivery: undefined,
    };
    store.keep(email, session);
    const own = intoMailbox(email, app, ["SENT"], session, threadId);
    if (!store.halted(email, session)) deliverTo(email, session, app);
    return own;
  };

  /** What a test has an app it made send: the message its own client would write, through `users.messages.send`. */
  const sendAs = async (
    session: string,
    app: GoogleAppRecord,
    input: EmailAppMessageInput & { inReplyTo?: string | undefined; references?: readonly string[] },
    threadId?: string,
  ) => {
    const raw = await composeMime(
      {
        from: { address: app.address, name: app.name },
        to: input.to,
        cc: input.cc,
        bcc: [],
        replyTo: [],
        subject: input.subject,
        text: input.text,
        html: input.html,
        messageId: messageId(ids.next(GOOGLE_IDS.messageLocal), GMAIL_DOMAIN),
        inReplyTo: input.inReplyTo,
        references: input.references ?? [],
      },
      clock(),
      ownHeaders(input.headers),
    );
    const message = await appSends(raw, threadId, app, session);
    return emailOf(message);
  };

  /** The email a message of a mailbox is a copy of. */
  const emailOf = (message: GmailMessageRecord): GoogleEmailRecord => {
    const email = store.emails.find(message.email);
    if (!email) throw notFound();
    return email;
  };

  /** A person sends an email from their Gmail mailbox. To an app's address, a copy lands in its inbox, unread, and its watch hears of it. */
  const personSends = async (
    session: string,
    person: GoogleUserRecord,
    input: PersonMessage,
  ): Promise<GoogleEmailRecord> => {
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
      // Gmail's attachments come later (#89): a person's email has none yet.
      attachments: [],
      id,
      author: person.id,
      thread: conversationOf({ id, inReplyTo: input.inReplyTo, references }),
      createdAt: at,
      raw,
      headers: mimeHeaders(raw),
      agentCopy: undefined,
      delivery: undefined,
    };
    store.keep(email, session);
    deliverTo(email, session);
    return email;
  };

  return {
    store,
    /** A mailbox's OAuth client and refresh token: its agent's `GOOGLE_CLIENT_ID`, `…_SECRET` and `GOOGLE_REFRESH_TOKEN`. */
    credentials: (app: GoogleAppRecord) => ({
      clientId: context.apps.secret(app.name, "clientId"),
      clientSecret: context.apps.secret(app.name, "clientSecret"),
      refreshToken: context.apps.secret(app.name, "refreshToken"),
    }),
    isApp,
    principalOf: (email: GoogleEmailRecord) => emailAuthor(email, store.apps.all(), (id) => store.users.find(id)),
    /** The id of the key the certificates serve. */
    keyId,
    createApp,
    appSends,
    personSends,
    sendAs,
    emailOf,

    /** A person: a mailbox at `<name>@example.com` unless the test gives an address. Their id is their address. */
    createUser: (session: string, input: { name: string; address?: string | undefined }): GoogleUserRecord =>
      store.addPerson(session, input),

    /** A person replies to an email: to its sender (and everyone on it, with `all`), in its thread. */
    personReplies: (
      session: string,
      person: GoogleUserRecord,
      to: GoogleEmailRecord,
      input: { text: string | undefined; html: string | undefined; all: boolean },
    ): Promise<GoogleEmailRecord> =>
      personSends(session, person, { ...replyOf(person, to, input.all), text: input.text, html: input.html }),

    /** An app a test made replies, in the thread its mailbox has the email in, as its own client would. */
    replyAs: (
      session: string,
      app: GoogleAppRecord,
      to: GoogleEmailRecord,
      input: { text: string | undefined; html: string | undefined; all: boolean; headers: Record<string, string> },
    ) => {
      const copy = store.messagesOf(app.name).find((message) => message.email === to.id);
      return sendAs(
        session,
        app,
        { ...replyOf(app, to, input.all), text: input.text, html: input.html, headers: input.headers },
        copy?.threadId,
      );
    },

    /** Add and remove labels on a message of a mailbox, as `users.messages.modify` does. */
    modify(message: GmailMessageRecord, add: readonly string[], remove: readonly string[]): GmailMessageRecord {
      const { labels } = store.mailbox(message.mailbox);
      for (const label of [...add, ...remove]) {
        if (!labels.has(label)) throw invalid(`Invalid label: ${label}`);
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

    /** An app watches its mailbox: Gmail pushes its changes to the app's topic from now on. */
    watch(
      app: GoogleAppRecord,
      input: { topicName: string; labelIds: readonly string[]; behavior: "include" | "exclude" },
    ) {
      if (input.topicName !== pubsubOf(app.name).topic) {
        throw new GmailApiError(
          403,
          `Error sending test message to Cloud PubSub ${input.topicName} : User not authorized to perform this action.`,
          "forbidden",
          "PERMISSION_DENIED",
        );
      }
      const mailbox = mailboxOf(app);
      mailbox.watch = { ...input, expiration: clock() + WATCH_MS };
      return { historyId: mailbox.historyId, expiration: String(mailbox.watch.expiration) };
    },

    stop(app: GoogleAppRecord) {
      mailboxOf(app).watch = undefined;
    },

    /** What reached a person, oldest first. */
    inbox: (person: GoogleUserRecord) => store.mailTo(person.address),

    /** Send a push again, forged: signed by another key, with an expired token, or for another audience. */
    resend(session: string, id: string, options: { badSignature: boolean; stale?: boolean; wrongAudience?: boolean }) {
      if (options.wrongAudience) {
        return deliveries.resend(session, id, {
          ...options,
          forge: (secret, _body, atMs) => pushHeaders(secret, "https://example.com/not-the-agent", atMs),
        });
      }
      return deliveries.resend(session, id, options);
    },
    redeliver: (session: string, id: string) => deliveries.redeliver(session, id),
    deliveries: deliveries.deliveries,
    delivery: deliveries.delivery,

    /** A session closed: its held pushes go with it. */
    release(session: string) {
      for (const at of [...new Set([...held.keys(), ...lastPush.keys(), ...untold.keys()])]) {
        if (!at.endsWith(`\u0000${session}`)) continue;
        held.get(at)?.();
        held.delete(at);
        lastPush.delete(at);
        untold.delete(at);
      }
    },
  };
}

export type FakeGoogleWorld = ReturnType<typeof createFakeWorld>;
