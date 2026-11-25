import { deliveryKit, fixedRetries } from "../../../core/delivery/kit.ts";
import {
  domainOf,
  type Mailbox,
  messageId,
  messageIdsIn,
  parseAddresses,
  threadOf,
} from "../../../core/email/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { RESEND_IDS } from "../ids.ts";
import { principalOf, replyOf } from "../mail.ts";
import { resendPayloads } from "../payloads.ts";
import { RESEND_SECRETS } from "../secrets.ts";
import { signResendWebhook } from "../signing.ts";
import type { ResendEmailRecord, ResendLastEvent, ResendUserRecord } from "../world.ts";
import type { ResendStore } from "./store.ts";

/** Svix waits 15 seconds for the endpoint's answer. */
const ACK_WINDOW_MS = 15_000;
/** Resend's retries after the first attempt: 5 seconds, 5 minutes, 30 minutes, 2, 5, 10 and 10 hours. */
const RETRY_DELAYS_MS = [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000];
/** Receivers refuse a timestamp more than five minutes away; six is safely outside. */
const STALE_MS = 6 * 60_000;

/** Resend refusing the agent's call, with its status and error name (`validation_error`). */
export class ResendApiError extends Error {
  readonly status: number;
  readonly errorName: string;

  constructor(status: number, errorName: string, message: string) {
    super(message);
    this.status = status;
    this.errorName = errorName;
  }
}

/** What happens at Resend's test addresses (`delivered@resend.dev`, `bounced+label@resend.dev`). */
function testOutcome(address: string): ResendLastEvent | undefined {
  const match = /^(delivered|bounced|complained|suppressed)(?:\+[^@]*)?@resend\.dev$/.exec(address);
  // `suppressed@` takes no label.
  if (!match || (match[1] === "suppressed" && address !== "suppressed@resend.dev")) return undefined;
  return match[1] as ResendLastEvent;
}

/** What an email the agent sends through the API carries, as `POST /emails` takes it. */
export interface SendInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly replyTo: readonly string[];
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
}

export function createFakeWorld(context: DriverContext, store: ResendStore) {
  const { ids, clock } = context;

  /** Resend's deliveries: Svix's, signed over the attempt's time, retried on Resend's schedule. */
  const deliveries = deliveryKit(context, {
    driver: "resend",
    timeoutMs: ACK_WINDOW_MS,
    retry: fixedRetries(RETRY_DELAYS_MS),
    sign: (secret, body, atMs, { id }) => ({
      "user-agent": "Svix-Webhooks/1.0 (sender-resend; +https://www.svix.com/http-sender/)",
      ...signResendWebhook(secret, id, body, atMs),
    }),
    secret: () => context.secret("webhookSecret"),
    forgedSecret: () => RESEND_SECRETS.webhookSecret.generate(),
    staleMs: STALE_MS,
  });

  /** Send an event to the agent's webhook, if it is subscribed and has a URL. */
  const emit = (session: string | undefined, type: string, email: ResendEmailRecord, extra = {}) => {
    if (!store.app.events.includes(type) || context.webhookUrl === undefined || session === undefined) return undefined;
    const id = ids.next(RESEND_IDS.message);
    const payload =
      type === "email.received"
        ? resendPayloads.received(email, clock())
        : resendPayloads.outbound(type, email, clock(), extra);
    deliveries.send({
      id,
      session,
      type,
      url: context.webhookUrl,
      body: JSON.stringify(payload),
      meta: { payload, email: email.id, eventType: type, thread: email.thread },
    });
    return id;
  };

  /** The thread a new email joins (by its references), or a new one it starts. */
  const threadFor = (email: { id: string; inReplyTo?: string | undefined; references: readonly string[] }) =>
    threadOf(email, (id) => store.byMessageId(id)?.thread) ?? email.id;

  /** Keep an email, and the thread it starts. */
  const keep = (email: ResendEmailRecord, session: string | undefined) => {
    if (email.thread === email.id) {
      store.threads.add(email.id, { id: email.id, subject: email.subject, createdAt: email.createdAt }, session);
    }
    return store.emails.add(email.id, email, session);
  };

  const isApp = (mailbox: Mailbox) => mailbox.address === store.app.address;

  return {
    store,
    principalOf: (email: ResendEmailRecord) => principalOf(store, email),
    isApp,

    /** A person: a mailbox at `<name>@example.com` unless the test gives an address. Their id is their address. */
    createUser(session: string, input: { name: string; address?: string | undefined }): ResendUserRecord {
      let address = input.address?.toLowerCase();
      if (address !== undefined) {
        if (parseAddresses(address)[0]?.address !== address) {
          throw new ProtocolError("invalid_argument", `"${input.address}" is not an email address`);
        }
        if (store.personAt(address) || address === store.app.address) {
          throw new ProtocolError("invalid_argument", `Someone has the address ${address} already`);
        }
      } else {
        const local =
          input.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ".")
            .replace(/^\.|\.$/g, "") || "person";
        address = `${local}@example.com`;
        for (let n = 2; store.personAt(address); n++) address = `${local}${n}@example.com`;
      }
      return store.users.add(address, { id: address, name: input.name, address, fixedId: false }, session);
    },

    /**
     * A person sends an email, from their mailbox. To the agent's address it reaches the agent's
     * team as a received email (`email.received`); to anyone else it stays in the outside world.
     */
    personSends(
      session: string,
      person: ResendUserRecord,
      input: {
        to: readonly Mailbox[];
        cc: readonly Mailbox[];
        subject: string;
        text: string | undefined;
        html: string | undefined;
        inReplyTo?: string | undefined;
        references?: readonly string[];
      },
    ): ResendEmailRecord {
      const id = ids.next(RESEND_IDS.email);
      const toApp = [...input.to, ...input.cc].some(isApp);
      const email: ResendEmailRecord = {
        id,
        direction: toApp ? "received" : "outside",
        author: person.id,
        from: { address: person.address, name: person.name },
        to: input.to,
        cc: input.cc,
        bcc: [],
        replyTo: [],
        subject: input.subject,
        text: input.text,
        html: input.html,
        headers: {},
        tags: {},
        messageId: messageId(ids.next(RESEND_IDS.messageLocal), domainOf(person.address)),
        inReplyTo: input.inReplyTo,
        references: input.references ?? [],
        thread: threadFor({ id, inReplyTo: input.inReplyTo, references: input.references ?? [] }),
        createdAt: clock(),
        lastEvent: undefined,
        delivery: undefined,
      };
      keep(email, session);
      if (toApp) email.delivery = emit(session, "email.received", email);
      return email;
    },

    /** A person replies to an email: to its sender (and everyone on it, with `all`), in its thread. */
    personReplies(
      session: string,
      person: ResendUserRecord,
      to: ResendEmailRecord,
      input: { text: string | undefined; html: string | undefined; all: boolean },
    ): ResendEmailRecord {
      return this.personSends(session, person, {
        ...replyOf(person, to, input.all),
        text: input.text,
        html: input.html,
      });
    },

    /**
     * The agent sends an email through the API (`POST /emails`). Its domain must be the team's
     * verified one. Each recipient gets it, Resend's test addresses do what they are for, and the
     * webhook hears `email.sent` and then what happened.
     */
    appSends(input: SendInput): ResendEmailRecord {
      const [from] = parseAddresses(input.from);
      if (!from) throw new ResendApiError(422, "validation_error", "Invalid `from` field.");
      if (domainOf(from.address) !== store.app.domain) {
        throw new ResendApiError(
          403,
          "validation_error",
          `The ${domainOf(from.address)} domain is not verified. Please, add and verify your domain on https://resend.com/domains`,
        );
      }
      const to = parseAddresses(input.to);
      if (to.length === 0) throw new ResendApiError(422, "validation_error", "Invalid `to` field.");
      if (to.length > 50) throw new ResendApiError(422, "validation_error", "Too many recipients: the limit is 50.");
      if (input.text === undefined && input.html === undefined) {
        throw new ResendApiError(422, "validation_error", "Missing `html` or `text` field.");
      }
      const headers = Object.fromEntries(
        Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value]),
      );
      const inReplyTo = messageIdsIn(headers["in-reply-to"])[0];
      const references = messageIdsIn(headers.references);
      const id = ids.next(RESEND_IDS.email);
      const thread = threadFor({ id, inReplyTo, references });
      // The email belongs to the session of the thread it answers, or of a person it reaches.
      const cc = parseAddresses(input.cc);
      const bcc = parseAddresses(input.bcc);
      const reached = [...to, ...cc, ...bcc].map((mailbox) => store.personAt(mailbox.address)).find(Boolean);
      const session =
        thread !== id ? store.threads.owner(thread) : reached === undefined ? undefined : store.users.owner(reached.id);
      const outcomes = to.map((mailbox) => testOutcome(mailbox.address) ?? "delivered");
      const lastEvent: ResendLastEvent =
        outcomes.find((outcome) => outcome === "bounced" || outcome === "suppressed") ??
        outcomes.find((outcome) => outcome === "complained") ??
        "delivered";
      const email: ResendEmailRecord = {
        id,
        direction: "sent",
        author: store.app.id,
        from,
        to,
        cc,
        bcc,
        replyTo: parseAddresses(input.replyTo),
        subject: input.subject,
        text: input.text,
        html: input.html,
        headers: Object.fromEntries(
          Object.entries(input.headers).filter(([name]) => !/^(in-reply-to|references)$/i.test(name)),
        ),
        tags: input.tags,
        messageId: messageId(ids.next(RESEND_IDS.messageLocal), store.app.domain),
        inReplyTo,
        references,
        thread,
        createdAt: clock(),
        lastEvent,
        delivery: undefined,
      };
      keep(email, session);
      emit(session, "email.sent", email);
      if (lastEvent === "bounced") {
        emit(session, "email.bounced", email, {
          bounce: {
            type: "Permanent",
            subType: "General",
            message:
              "The recipient's email address is on the suppression list because it has a recent history of producing hard bounces.",
          },
        });
      } else if (lastEvent === "suppressed") {
        emit(session, "email.suppressed", email);
      } else {
        emit(session, "email.delivered", email);
        if (lastEvent === "complained") emit(session, "email.complained", email);
      }
      return email;
    },

    /** What reached a person, oldest first. */
    inbox: (person: ResendUserRecord) => store.mailTo(person.address),

    /** The sessions an agent's call touched: the email's. */
    sessionOf: (email: ResendEmailRecord) => store.emails.owner(email.id),

    resend: (session: string, id: string, options: { badSignature: boolean; stale?: boolean }) =>
      deliveries.resend(session, id, options),
    redeliver: (session: string, id: string) => deliveries.redeliver(session, id),
    deliveries: deliveries.deliveries,
    delivery: deliveries.delivery,
  };
}

export type FakeResendWorld = ReturnType<typeof createFakeWorld>;
