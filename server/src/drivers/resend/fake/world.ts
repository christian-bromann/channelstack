import { deliveryKit, fixedRetries } from "../../../core/delivery/kit.ts";
import {
  domainOf,
  type EmailAttachment,
  emailAuthor,
  formatMailbox,
  type Mailbox,
  messageId,
  messageIdsIn,
  parseAddresses,
  replyOf,
  threadOf,
} from "../../../core/email/index.ts";
import { composeMime, type MimeMessage, ownHeaders, withHeaders } from "../../../core/email/mime.ts";
import type { EmailAppMessageInput } from "../../../core/email/routes.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { RESEND_IDS } from "../ids.ts";
import { EMAIL_EVENTS, resendPayloads } from "../payloads.ts";
import { RESEND_SECRETS } from "../secrets.ts";
import { signResendWebhook } from "../signing.ts";
import type { ResendAppRecord, ResendEmailRecord, ResendLastEvent, ResendUserRecord } from "../world.ts";
import type { ResendStore } from "./store.ts";

/** Where Resend's email comes from: it sends through Amazon SES, which names each `Message-ID` there. */
const SES_DOMAIN = "email.amazonses.com";
/** Svix waits 15 seconds for the endpoint's answer. */
const ACK_WINDOW_MS = 15_000;
/** Resend's retries after the first attempt: 5 seconds, 5 minutes, 30 minutes, 2, 5, 10 and 10 hours. */
const RETRY_DELAYS_MS = [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000];
/** Receivers refuse a timestamp more than five minutes away; six is safely outside. */
const STALE_MS = 6 * 60_000;
/** Where another app's team receives by default: `<name>.acme.example`, a domain of its own. */
const APP_DOMAIN = "acme.example";
/** A domain as Resend takes one: labels of letters, digits and hyphens, at least two. */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

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

/** A file an email carries, before Resend gives it an id. */
export type AttachmentFile = Omit<EmailAttachment, "id" | "size" | "content"> & { readonly content: Uint8Array };

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
  readonly attachments: readonly AttachmentFile[];
}

export function createFakeWorld(context: DriverContext, store: ResendStore) {
  const { ids, clock } = context;

  /** Resend's deliveries: Svix's, signed over the attempt's time with the team's secret, retried on Resend's schedule. */
  const deliveries = deliveryKit(context, {
    driver: "resend",
    timeoutMs: ACK_WINDOW_MS,
    retry: fixedRetries(RETRY_DELAYS_MS),
    sign: (secret, body, atMs, { id }) => ({
      "user-agent": "Svix-Webhooks/1.0 (sender-resend; +https://www.svix.com/http-sender/)",
      ...signResendWebhook(secret, id, body, atMs),
    }),
    secret: (app) => context.apps.secret(app, "webhookSecret"),
    forgedSecret: () => RESEND_SECRETS.webhookSecret.generate(),
    staleMs: STALE_MS,
  });

  /** Send an event to a team's webhook, if it is subscribed and has a URL. */
  const emit = (
    session: string | undefined,
    team: ResendAppRecord,
    type: string,
    email: ResendEmailRecord,
    extra = {},
  ) => {
    const url = context.apps.webhookUrl(team.name);
    if (!team.events.includes(type) || url === undefined || session === undefined) return undefined;
    const id = ids.next(RESEND_IDS.message);
    const payload =
      type === "email.received"
        ? resendPayloads.received(email, clock())
        : resendPayloads.outbound(type, email, clock(), extra);
    deliveries.send({
      id,
      session,
      type,
      url,
      app: team.name,
      body: JSON.stringify(payload),
      meta: { payload, email: email.id, eventType: type, thread: email.thread },
    });
    return id;
  };

  /** The teams an email reaches: every team whose address it is to, but the one that sent it. */
  const receivers = (
    email: { to: readonly Mailbox[]; cc: readonly Mailbox[]; bcc: readonly Mailbox[] },
    from?: string,
  ) => store.appsAmong([...email.to, ...email.cc, ...email.bcc]).filter((team) => team.name !== from);

  /** Each team the email reaches hears `email.received`; the built-in team's is the email's delivery. */
  const receive = (session: string | undefined, email: ResendEmailRecord) => {
    for (const team of receivers(email, email.team)) {
      const id = emit(session, team, "email.received", email);
      if (team === store.app) email.delivery = id;
    }
  };

  /**
   * The message as a receiving team's server got it: what the sender wrote, with the headers it
   * set itself, and what the servers on the way stamped first.
   */
  const receivedRaw = async (
    message: MimeMessage & { attachments: readonly EmailAttachment[] },
    id: string,
    at: number,
    headers: Readonly<Record<string, string>> = {},
  ) => {
    const sender = domainOf(message.from.address);
    return withHeaders(await composeMime(message, at, ownHeaders(headers)), {
      Received: `from ${sender} by inbound-smtp.us-east-1.amazonaws.com with SMTP id ${id}; ${new Date(at).toUTCString()}`,
      "DKIM-Signature": `v=1; a=rsa-sha256; c=relaxed/simple; d=${sender}; s=resend; h=From:To:Subject:Message-ID:Date`,
    });
  };

  /** The thread a new email joins (by its references), or a new one it starts. */
  const threadFor = (email: { id: string; inReplyTo?: string | undefined; references: readonly string[] }) =>
    threadOf(email, (id) => store.byMessageId(id)?.thread) ?? email.id;

  const isApp = (mailbox: Mailbox) => store.appAt(mailbox.address) !== undefined;

  /** The attachments an email keeps, each with Resend's id for it. */
  const keptFiles = (files: readonly AttachmentFile[] = []): EmailAttachment[] =>
    files.map((file) => ({ ...file, id: ids.next(RESEND_IDS.attachment), size: file.content.byteLength }));

  /**
   * Another app's team (`createApp`): its own API key and webhook secret, and its own domain,
   * `<name>.acme.example` unless `domain` says, with the address `<name>@<domain>`.
   */
  const createApp = (session: string | undefined, input: { name: string; domain?: string | undefined }) => {
    const domain = (input.domain ?? `${input.name}.${APP_DOMAIN}`).toLowerCase();
    if (!DOMAIN.test(domain)) {
      throw new ProtocolError("invalid_argument", `"${input.domain}" isn't a domain`, { domain: input.domain });
    }
    const owner = store.apps.all().find((team) => team.domain === domain);
    if (owner && owner.name !== input.name) {
      throw new ProtocolError("invalid_argument", `The domain ${domain} belongs to the ${owner.name} team already`, {
        domain,
      });
    }
    return store.makeApp(session, input.name, { domain }, () => {
      const appIds = context.apps.ids(input.name);
      return {
        id: appIds.next(RESEND_IDS.domain),
        name: input.name,
        address: `${input.name}@${domain}`,
        domain,
        domainId: appIds.next(RESEND_IDS.domain),
        webhookId: appIds.next(RESEND_IDS.webhook),
        events: EMAIL_EVENTS,
      };
    });
  };

  /**
   * Check an email a team sends, as Resend does before it accepts one: the domain is the team's
   * verified one, and it has someone to go to and a body. Throws Resend's refusal; sends nothing.
   */
  const checkSend = (input: SendInput, team: ResendAppRecord) => {
    const [from] = parseAddresses(input.from);
    if (!from) throw new ResendApiError(422, "validation_error", "Invalid `from` field.");
    if (domainOf(from.address) !== team.domain) {
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
    const cc = parseAddresses(input.cc);
    const bcc = parseAddresses(input.bcc);
    // The email belongs to the session of the thread it answers, or of a person it reaches.
    const { thread, session } = store.placeOf({ inReplyTo, references }, [...to, ...cc, ...bcc]);
    return { from, to, cc, bcc, inReplyTo, references, thread, session };
  };

  /**
   * A team sends an email through the API (`POST /emails`), or a test as an app it made (then in
   * the test's `session`). Its domain must be the team's verified one. Each recipient gets it,
   * Resend's test addresses do what they are for, another team it reaches hears `email.received`,
   * and the sending team's webhook hears `email.sent` and then what happened.
   */
  const appSends = async (input: SendInput, team: ResendAppRecord, acting?: string): Promise<ResendEmailRecord> => {
    const checked = checkSend(input, team);
    const { from, to, cc, bcc, inReplyTo, references } = checked;
    const session = acting ?? checked.session;
    const id = ids.next(RESEND_IDS.email);
    const at = clock();
    const thread = checked.thread ?? id;
    const outcomes = to.map((mailbox) => testOutcome(mailbox.address) ?? "delivered");
    const lastEvent: ResendLastEvent =
      outcomes.find((outcome) => outcome === "bounced" || outcome === "suppressed") ??
      outcomes.find((outcome) => outcome === "complained") ??
      "delivered";
    const message = {
      from,
      to,
      cc,
      bcc,
      replyTo: parseAddresses(input.replyTo),
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: keptFiles(input.attachments),
      messageId: messageId(ids.next(RESEND_IDS.messageLocal), SES_DOMAIN),
      inReplyTo,
      references,
    };
    const reaches = receivers(message, team.name).length > 0;
    const email: ResendEmailRecord = {
      ...message,
      id,
      direction: "sent",
      team: team.name,
      author: team.id,
      // Every header the agent set, `In-Reply-To`, `References` and `Auto-Submitted` too: the webhooks list them.
      headers: input.headers,
      tags: input.tags,
      // As another team it reaches received it, with the headers the sender set.
      raw: reaches ? await receivedRaw(message, id, at, input.headers) : undefined,
      thread,
      createdAt: at,
      lastEvent,
      delivery: undefined,
    };
    store.keep(email, session);
    if (store.halted(email)) return email;
    emit(session, team, "email.sent", email);
    if (lastEvent === "bounced") {
      emit(session, team, "email.bounced", email, {
        bounce: {
          type: "Permanent",
          subType: "General",
          message:
            "The recipient's email provider sent a hard bounce message, but didn't specify the reason for the hard bounce.",
          diagnosticCode: ["smtp; 550 5.1.1 user unknown"],
        },
      });
    } else if (lastEvent === "suppressed") {
      emit(session, team, "email.suppressed", email, {
        suppressed: {
          type: "OnAccountSuppressionList",
          reason: "previous_bounce",
          message:
            "The email address is on the suppression list because it has a recent history of producing hard bounces.",
          diagnosticCode: [],
        },
      });
    } else {
      emit(session, team, "email.delivered", email);
      if (lastEvent === "complained") emit(session, team, "email.complained", email);
    }
    receive(session, email);
    return email;
  };

  /** What a test has an app it made send, as that team's own `POST /emails` would. */
  const sendAs = (session: string, team: ResendAppRecord, input: EmailAppMessageInput) =>
    appSends(
      {
        from: formatMailbox({ address: team.address, name: team.name }),
        to: input.to.map(formatMailbox),
        cc: input.cc.map(formatMailbox),
        bcc: [],
        replyTo: [],
        subject: input.subject,
        text: input.text,
        html: input.html,
        headers: input.headers,
        tags: {},
        attachments: [],
      },
      team,
      session,
    );

  /** A person sends an email, from their mailbox. To a team's address it is received (`email.received`). */
  const personSends = async (
    session: string,
    person: ResendUserRecord,
    input: {
      to: readonly Mailbox[];
      cc: readonly Mailbox[];
      subject: string;
      text: string | undefined;
      html: string | undefined;
      attachments?: readonly AttachmentFile[];
      inReplyTo?: string | undefined;
      references?: readonly string[];
    },
  ): Promise<ResendEmailRecord> => {
    const id = ids.next(RESEND_IDS.email);
    const at = clock();
    const toApp = [...input.to, ...input.cc].some(isApp);
    const message = {
      from: { address: person.address, name: person.name },
      to: input.to,
      cc: input.cc,
      bcc: [],
      replyTo: [],
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: keptFiles(input.attachments),
      // A person's mail goes out through Resend too, in the sandbox, so it has an SES id as well.
      messageId: messageId(ids.next(RESEND_IDS.messageLocal), SES_DOMAIN),
      inReplyTo: input.inReplyTo,
      references: input.references ?? [],
    };
    const email: ResendEmailRecord = {
      ...message,
      id,
      direction: toApp ? "received" : "outside",
      team: undefined,
      author: person.id,
      headers: {},
      tags: {},
      raw: toApp ? await receivedRaw(message, id, at) : undefined,
      thread: threadFor({ id, inReplyTo: input.inReplyTo, references: input.references ?? [] }),
      createdAt: at,
      lastEvent: undefined,
      delivery: undefined,
    };
    store.keep(email, session);
    if (toApp) receive(session, email);
    return email;
  };

  return {
    store,
    /** A team's API key and webhook secret: its agent's `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`. */
    credentials: (team: ResendAppRecord) => ({
      apiKey: context.apps.secret(team.name, "apiKey"),
      webhookSecret: context.apps.secret(team.name, "webhookSecret"),
    }),
    principalOf: (email: ResendEmailRecord) => emailAuthor(email, store.apps.all(), (id) => store.users.find(id)),
    isApp,
    createApp,
    checkSend,
    appSends,
    personSends,

    /** A person: a mailbox at `<name>@example.com` unless the test gives an address. Their id is their address. */
    createUser: (session: string, input: { name: string; address?: string | undefined }): ResendUserRecord =>
      store.addPerson(session, input),

    /** A person replies to an email: to its sender (and everyone on it, with `all`), in its thread. */
    personReplies: (
      session: string,
      person: ResendUserRecord,
      to: ResendEmailRecord,
      input: { text: string | undefined; html: string | undefined; all: boolean },
    ): Promise<ResendEmailRecord> =>
      personSends(session, person, { ...replyOf(person, to, input.all), text: input.text, html: input.html }),

    sendAs,

    /** An app a test made replies, in the thread, with `In-Reply-To` and `References` as its own call sets them. */
    replyAs: (
      session: string,
      team: ResendAppRecord,
      to: ResendEmailRecord,
      input: { text: string | undefined; html: string | undefined; all: boolean; headers: Record<string, string> },
    ) => {
      const { inReplyTo, references, ...message } = replyOf(team, to, input.all);
      return sendAs(session, team, {
        ...message,
        text: input.text,
        html: input.html,
        headers: { ...input.headers, "In-Reply-To": inReplyTo, References: references.join(" ") },
      });
    },

    /** Whether a team received this email: one it is to, from a person or another team. */
    receivedBy: (team: ResendAppRecord, email: ResendEmailRecord) =>
      email.direction !== "outside" &&
      email.team !== team.name &&
      [...email.to, ...email.cc, ...email.bcc].some((mailbox) => mailbox.address === team.address),

    /** Whether a team sent this email. */
    sentBy: (team: ResendAppRecord, email: ResendEmailRecord) => email.direction === "sent" && email.team === team.name,

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
