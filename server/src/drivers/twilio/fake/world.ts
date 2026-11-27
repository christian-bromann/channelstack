import type { DeliveryAttempt, RetryPolicy } from "../../../core/delivery/index.ts";
import { deliveryKit, fixedRetries } from "../../../core/delivery/kit.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { TWILIO_IDS } from "../ids.ts";
import { twilioPayloads } from "../payloads.ts";
import { TWILIO_SECRETS } from "../secrets.ts";
import { twilioSignature } from "../signing.ts";
import { BODY_LIMIT, isE164, OPT_OUT_REPLIES, optOutTypeOf, segmentsOf } from "../sms.ts";
import { readTwiml } from "../twiml.ts";
import type { TwilioDirection, TwilioMessageRecord, TwilioPersonRecord } from "../world.ts";
import type { TwilioStore } from "./store.ts";

/** Twilio's connection overrides when the URL has none: a 15-second total, one retry on a connection failure. */
const DEFAULT_OVERRIDES = { totalMs: 15_000, readMs: 15_000, retries: 1, policy: ["ct"] } as const;
/** How long after a failed attempt Twilio tries again: at once, in the same request. */
const RETRY_AFTER_MS = 500;
/** Twilio's test numbers: with the test credentials, `From` passes only as this one. */
const MAGIC_FROM = "+15005550006";

/** Twilio refusing the agent's call: its HTTP status, its error code, its message. */
export class TwilioApiError extends Error {
  readonly status: number;
  readonly code: number;

  constructor(status: number, code: number, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const refused = (code: number, message: string) => new TwilioApiError(400, code, message);

/**
 * A webhook URL's connection overrides, as Twilio reads them from its fragment: `ct` (connect
 * timeout), `rt` (read timeout), `tt` (total time), in milliseconds; `rc`, how many retries; `rp`,
 * which failures to retry (`4xx`, `5xx`, `rt`, `ct`, `all`).
 */
function connectionOverrides(url: string) {
  const fragment = new URLSearchParams(url.split("#")[1] ?? "");
  /** An override, held to the range Twilio documents for it; one that isn't a number is left out. */
  const number = (name: string, fallback: number, [min, max]: readonly [number, number]) => {
    const value = Number(fragment.get(name));
    return fragment.has(name) && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
  };
  const policy = fragment.get("rp")?.split(",") ?? [...DEFAULT_OVERRIDES.policy];
  return {
    url: url.split("#")[0] as string,
    timeoutMs: Math.min(
      number("tt", DEFAULT_OVERRIDES.totalMs, [100, 15_000]),
      number("rt", DEFAULT_OVERRIDES.readMs, [100, 15_000]),
    ),
    retry: retryPolicy(number("rc", DEFAULT_OVERRIDES.retries, [0, 5]), policy),
  };
}

/** Twilio's retries of a webhook: `retries` of them, for the failures `policy` names. */
function retryPolicy(retries: number, policy: readonly string[]): RetryPolicy {
  const retried = (attempt: DeliveryAttempt) =>
    policy.includes("all") ||
    (attempt.status === "unreachable" && policy.includes("ct")) ||
    (attempt.status === "timed_out" && policy.includes("rt")) ||
    (attempt.status === "failed" &&
      policy.includes(`${String(attempt.responseStatus ?? 0).slice(0, 1)}xx`) &&
      (attempt.responseStatus ?? 0) >= 400);
  return fixedRetries(
    Array.from({ length: retries }, () => RETRY_AFTER_MS),
    (attempt) => (retried(attempt) ? {} : undefined),
  );
}

/** What the agent asks Twilio to send, from the REST API or a TwiML answer. */
export interface SendInput {
  readonly to: string | undefined;
  readonly from: string | undefined;
  readonly messagingServiceSid: string | undefined;
  readonly body: string;
  readonly media: readonly string[];
  readonly statusCallback: string | undefined;
}

export function createFakeWorld(context: DriverContext, store: TwilioStore) {
  const { ids, clock } = context;

  /** Twilio's deliveries: form-encoded, signed over the URL and the parameters, retried as the URL says. */
  const deliveries = deliveryKit(context, {
    driver: "twilio",
    timeoutMs: DEFAULT_OVERRIDES.totalMs,
    sign: (secret, body, _atMs, { id, url }) => ({
      "user-agent": "TwilioProxy/1.1",
      "x-twilio-signature": twilioSignature(secret, url, body),
      "i-twilio-idempotency-token": id,
      "x-home-region": "us1",
    }),
    secret: () => context.secret("authToken"),
    forgedSecret: () => TWILIO_SECRETS.authToken.generate(),
  });

  /** A message's record, in its conversation. */
  const record = (
    input: Omit<TwilioMessageRecord, "id" | "conversation" | "createdAt" | "updatedAt" | "delivery" | "segments">,
    session: string | undefined,
  ): TwilioMessageRecord => {
    const id = ids.next(TWILIO_IDS.message);
    const at = clock();
    const message: TwilioMessageRecord = {
      ...input,
      id,
      segments: segmentsOf(input.body),
      conversation: store.conversationFor(input.from, input.to, id, at, session),
      createdAt: at,
      updatedAt: at,
      delivery: undefined,
    };
    return store.keep(message, session);
  };

  /** Tell the agent what became of a message it sent, at the callback URL it gave. */
  const statusCallback = (message: TwilioMessageRecord, status: string) => {
    const session = store.messages.owner(message.id);
    if (message.statusCallback === undefined || session === undefined) return;
    const { url, timeoutMs, retry } = connectionOverrides(message.statusCallback);
    const body = twilioPayloads.status(message, store.app.accountSid, status, clock());
    deliveries.send({
      id: ids.next(TWILIO_IDS.idempotency),
      session,
      type: "status",
      url,
      timeoutMs,
      retry,
      contentType: "application/x-www-form-urlencoded",
      body,
      meta: {
        message: message.id,
        conversation: message.conversation,
        payload: Object.fromEntries(new URLSearchParams(body)),
      },
    });
  };

  /** A message the app sends, past Twilio's checks: kept, sent, and its status told. */
  const sendFromApp = (input: SendInput, direction: TwilioDirection): TwilioMessageRecord => {
    const to = input.to as string;
    const person = store.personAt(to);
    // The person's session; for a number no one in the test has, the conversation's, if there is one.
    const session = person ? store.users.owner(person.id) : undefined;
    return record(
      {
        accountSid: store.app.accountSid,
        from: store.app.number,
        to,
        body: input.body,
        media: input.media,
        direction,
        // Through a Messaging Service, Twilio has yet to pick a sender: `accepted`.
        status: input.messagingServiceSid === undefined ? "queued" : "accepted",
        errorCode: undefined,
        author: store.app.id,
        automatic: false,
        messagingServiceSid: input.messagingServiceSid,
        statusCallback: input.statusCallback,
        sentAt: undefined,
      },
      session,
    );
  };

  /** What happens to a sent message after Twilio took it: on its way, then on the phone, or not. */
  /**
   * What happens to a sent message after Twilio took it. A callback tells of each change from the
   * status it was answered with: through a Messaging Service, `accepted`, then `queued` once a sender
   * is chosen; then `sent`, and `delivered` or `undelivered`.
   */
  const deliver = (message: TwilioMessageRecord) => {
    const person = store.personAt(message.to);
    if (message.status === "accepted") {
      message.status = "queued";
      statusCallback(message, "queued");
    }
    message.status = "sent";
    message.sentAt = clock();
    message.updatedAt = clock();
    statusCallback(message, "sent");
    if (person && !person.reachable) {
      message.status = "undelivered";
      message.errorCode = 30003;
    } else {
      message.status = "delivered";
    }
    message.updatedAt = clock();
    statusCallback(message, message.status);
  };

  /**
   * Check what the agent asks to send, as Twilio does before it takes a message: someone to go to,
   * something to send, a number of the account's to send from. Throws Twilio's refusal; sends nothing.
   */
  const check = (input: SendInput) => {
    if (input.to === undefined || input.to === "") throw refused(21604, "A 'To' phone number is required.");
    if (!input.from && !input.messagingServiceSid) throw refused(21603, "A 'From' phone number is required.");
    if (input.body === "" && input.media.length === 0) throw refused(21602, "Message body is required.");
    if (input.messagingServiceSid !== undefined && input.messagingServiceSid !== store.app.messagingServiceSid) {
      throw refused(21701, `The Messaging Service Sid ${input.messagingServiceSid} is invalid.`);
    }
    if (input.from !== undefined && input.from !== "") {
      if (!isE164(input.from)) throw refused(21212, `Invalid 'From' Phone Number: ${input.from}`);
      if (input.from !== store.app.number) {
        throw refused(
          21606,
          `The From phone number ${input.from} is not a valid, SMS-capable inbound phone number or short code for your account.`,
        );
      }
    }
    if (!isE164(input.to)) throw refused(21211, `Invalid 'To' Phone Number: ${input.to}`);
    if (input.to === store.app.number) throw refused(21266, `'To' and 'From' number cannot be the same: ${input.to}`);
    if (input.body.length > BODY_LIMIT) {
      throw refused(21617, "The concatenated message body exceeds the 1600 character limit.");
    }
    if (store.optedOut.has(input.to)) throw refused(21610, "Attempt to send to unsubscribed recipient");
  };

  /**
   * What the agent's answer to a text sends: each `<Message>` of TwiML, back to the sender unless it
   * says otherwise. A plain-text answer is sent back as it is, as Twilio does with `text/plain`.
   */
  const answerWith = (incoming: TwilioMessageRecord, answer: { contentType: string; body: string }) => {
    const plain = answer.contentType.toLowerCase().startsWith("text/plain");
    const messages = plain
      ? answer.body.trim() === ""
        ? []
        : [{ to: undefined, from: undefined, body: answer.body, media: [], statusCallback: undefined }]
      : readTwiml(answer.body);
    for (const message of messages) {
      const input: SendInput = {
        to: message.to ?? incoming.from,
        from: message.from ?? incoming.to,
        messagingServiceSid: undefined,
        body: message.body,
        media: message.media,
        statusCallback: message.statusCallback,
      };
      check(input);
      deliver(sendFromApp(input, "outbound-reply"));
    }
  };

  /** Send the agent the webhook of a text to its number. */
  const emitIncoming = (session: string, message: TwilioMessageRecord) => {
    if (context.webhookUrl === undefined) return undefined;
    const { url, timeoutMs, retry } = connectionOverrides(context.webhookUrl);
    const body = twilioPayloads.incoming(message, store.app);
    const delivery = deliveries.send({
      id: ids.next(TWILIO_IDS.idempotency),
      session,
      type: "message",
      url,
      timeoutMs,
      retry,
      contentType: "application/x-www-form-urlencoded",
      body,
      meta: {
        message: message.id,
        conversation: message.conversation,
        payload: Object.fromEntries(new URLSearchParams(body)),
      },
      answered: (answer) => answerWith(message, answer),
    });
    return delivery.request.id;
  };

  return {
    store,
    check,

    /** A person: a phone, with a number the fake hands out unless the test gives one. Their id is their number. */
    createUser(session: string, input: { name: string; number?: string | undefined; reachable?: boolean | undefined }) {
      let number = input.number;
      if (number !== undefined) {
        if (!isE164(number)) throw new ProtocolError("invalid_argument", `"${number}" isn't a number in E.164`);
        if (store.personAt(number) || number === store.app.number) {
          throw new ProtocolError("invalid_argument", `Someone has the number ${number} already`);
        }
      } else {
        do number = ids.next(TWILIO_IDS.number);
        while (store.personAt(number) || number === store.app.number);
      }
      const person: TwilioPersonRecord = {
        id: number,
        name: input.name,
        number,
        reachable: input.reachable ?? true,
      };
      return store.users.add(number, person, session);
    },

    /**
     * A person texts someone: the agent's number, where Twilio posts it to the agent's webhook, or
     * another person, which Twilio never sees. Twilio answers `STOP`, `START` and `HELP` itself.
     */
    personTexts(
      session: string,
      person: TwilioPersonRecord,
      input: { to: string; body: string; media: readonly string[] },
    ): TwilioMessageRecord {
      const toApp = input.to === store.app.number;
      const message = record(
        {
          accountSid: toApp ? store.app.accountSid : undefined,
          from: person.number,
          to: input.to,
          body: input.body,
          media: input.media,
          direction: "inbound",
          status: "received",
          errorCode: undefined,
          author: person.id,
          automatic: false,
          messagingServiceSid: toApp ? store.app.messagingServiceSid : undefined,
          statusCallback: undefined,
          sentAt: clock(),
        },
        session,
      );
      if (!toApp) return message;
      const optOut = optOutTypeOf(input.body);
      if (optOut === "STOP") store.optedOut.set(person.number, session);
      if (optOut === "START") store.optedOut.delete(person.number);
      // With Twilio's default opt-out handling the agent gets the text as it is, `STOP` too.
      message.delivery = emitIncoming(session, message);
      if (optOut !== undefined) {
        // Twilio's own answer, from the agent's number: the agent didn't write it.
        record(
          {
            accountSid: store.app.accountSid,
            from: store.app.number,
            to: person.number,
            body: OPT_OUT_REPLIES[optOut],
            media: [],
            direction: "outbound-reply",
            status: "delivered",
            errorCode: undefined,
            author: store.app.id,
            automatic: true,
            messagingServiceSid: store.app.messagingServiceSid,
            statusCallback: undefined,
            sentAt: clock(),
          },
          session,
        );
      }
      return message;
    },

    /**
     * The agent sends a message through the API (`POST …/Messages.json`), once `check` passed: it
     * answers `queued`, and the message is sent and delivered (or not) right after.
     */
    appSends(input: SendInput): { message: TwilioMessageRecord; queued: ReturnType<typeof twilioPayloads.message> } {
      check(input);
      const message = sendFromApp(input, "outbound-api");
      const queued = twilioPayloads.message(message, store.app.accountSid);
      deliver(message);
      return { message, queued };
    },

    /**
     * What Twilio answers the test credentials, which send nothing: the magic numbers' refusals, or
     * a message that is `queued` and kept nowhere.
     */
    testSend(input: SendInput, testAccountSid: string) {
      if (input.to === undefined || input.to === "") throw refused(21604, "A 'To' phone number is required.");
      if (!input.from) throw refused(21603, "A 'From' phone number is required.");
      if (input.body === "" && input.media.length === 0) throw refused(21602, "Message body is required.");
      const fromRefusals: Record<string, TwilioApiError> = {
        "+15005550001": refused(21212, `Invalid 'From' Phone Number: ${input.from}`),
        "+15005550007": refused(
          21606,
          `The From phone number ${input.from} is not a valid, SMS-capable inbound phone number or short code for your account.`,
        ),
        "+15005550008": refused(21611, "This 'From' number has exceeded the maximum number of queued messages"),
      };
      const fromRefusal = fromRefusals[input.from];
      if (fromRefusal) throw fromRefusal;
      if (input.from !== MAGIC_FROM) {
        throw refused(
          21606,
          `The From phone number ${input.from} is not a valid, SMS-capable inbound phone number or short code for your account.`,
        );
      }
      const toRefusals: Record<string, TwilioApiError> = {
        "+15005550001": refused(21211, `Invalid 'To' Phone Number: ${input.to}`),
        "+15005550002": refused(21612, "The 'To' phone number is not currently reachable via SMS."),
        "+15005550003": refused(
          21408,
          `Permission to send an SMS has not been enabled for the region indicated by the 'To' number: ${input.to}`,
        ),
        "+15005550004": refused(21610, "Attempt to send to unsubscribed recipient"),
        "+15005550009": refused(21614, "'To' number is not a valid mobile number"),
      };
      const toRefusal = toRefusals[input.to];
      if (toRefusal) throw toRefusal;
      if (!isE164(input.to)) throw refused(21211, `Invalid 'To' Phone Number: ${input.to}`);
      const at = clock();
      const message: TwilioMessageRecord = {
        id: ids.next(TWILIO_IDS.message),
        accountSid: testAccountSid,
        from: input.from,
        to: input.to,
        body: input.body,
        media: input.media,
        segments: segmentsOf(input.body),
        direction: "outbound-api",
        status: "queued",
        errorCode: undefined,
        author: undefined,
        automatic: false,
        conversation: "",
        messagingServiceSid: undefined,
        statusCallback: undefined,
        createdAt: at,
        sentAt: undefined,
        updatedAt: at,
        delivery: undefined,
      };
      return twilioPayloads.message(message, testAccountSid);
    },

    /** What reached a person's phone, oldest first. */
    messagesTo: (person: TwilioPersonRecord) => store.messagesTo(person.number),

    /** The session an agent's call touched: the message's. */
    sessionOf: (message: TwilioMessageRecord) => store.messages.owner(message.id),

    resend: (session: string, id: string, options: { badSignature: boolean }) =>
      deliveries.resend(session, id, options),
    /** Twilio's retry of a webhook: the same request, the same idempotency token, its TwiML acted on. */
    redeliver: (session: string, id: string) => deliveries.redeliver(session, id, { answered: true }),
    deliveries: deliveries.deliveries,
    delivery: deliveries.delivery,
  };
}

export type FakeTwilioWorld = ReturnType<typeof createFakeWorld>;
