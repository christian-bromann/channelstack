import type { TwilioAppRecord, TwilioMessageRecord } from "./world.ts";

/** The version of the REST API every message is on. */
export const API_VERSION = "2010-04-01";

/** A time as Twilio writes it: RFC 2822, in GMT (`Thu, 24 Aug 2023 05:01:45 +0000`). */
export const rfc2822 = (ms: number): string => new Date(ms).toUTCString().replace(/GMT$/, "+0000");

/** What one SMS segment costs in the US, as Twilio prices it once a message is sent. */
const SEGMENT_PRICE = 0.0083;

/** Where Twilio documents an error code. */
const moreInfo = (code: number) => `https://www.twilio.com/docs/errors/${code}`;

/** What an error code means, as Twilio's `error_message` and its status callbacks say. */
const ERROR_MESSAGES: Readonly<Record<number, string>> = {
  30003: "Unreachable destination handset",
  30005: "Unknown destination handset",
};

/** A message's resource path, relative to `https://api.twilio.com`. */
const messageUri = (accountSid: string, sid: string) => `/${API_VERSION}/Accounts/${accountSid}/Messages/${sid}.json`;

/** The country a number is in, as the webhooks' `FromCountry` and `ToCountry` say: the fake knows North America's. */
const countryOf = (number: string) => (number.startsWith("+1") ? "US" : "");

export const twilioPayloads = {
  /** A Message resource, as the REST API answers it. */
  message(message: TwilioMessageRecord, accountSid: string) {
    const uri = messageUri(accountSid, message.id);
    const sent = message.sentAt !== undefined && message.direction !== "inbound";
    return {
      account_sid: accountSid,
      api_version: API_VERSION,
      body: message.body,
      date_created: rfc2822(message.createdAt),
      date_sent: message.sentAt === undefined ? null : rfc2822(message.sentAt),
      date_updated: rfc2822(message.updatedAt),
      direction: message.direction,
      error_code: message.errorCode ?? null,
      error_message: message.errorCode === undefined ? null : (ERROR_MESSAGES[message.errorCode] ?? null),
      from: message.from,
      messaging_service_sid: message.messagingServiceSid ?? null,
      num_media: String(message.media.length),
      num_segments: String(message.segments),
      price: sent || message.direction === "inbound" ? (-SEGMENT_PRICE * message.segments).toFixed(5) : null,
      price_unit: "USD",
      sid: message.id,
      status: message.status,
      subresource_uris: {
        media: uri.replace(/\.json$/, "/Media.json"),
        feedback: uri.replace(/\.json$/, "/Feedback.json"),
      },
      to: message.to,
      uri,
    };
  },

  /** A page of a list, with Twilio's paging fields around the items. */
  page<T>(path: string, key: string, items: readonly T[], page: number, size: number, query: URLSearchParams) {
    const start = page * size;
    const slice = items.slice(start, start + size);
    const at = (n: number) => {
      const params = new URLSearchParams(query);
      params.set("PageSize", String(size));
      params.set("Page", String(n));
      params.delete("PageToken");
      return `${path}?${params}`;
    };
    return {
      [key]: slice,
      end: start + Math.max(slice.length - 1, 0),
      first_page_uri: at(0),
      next_page_uri: start + size < items.length ? at(page + 1) : null,
      page,
      page_size: size,
      previous_page_uri: page > 0 ? at(page - 1) : null,
      start,
      uri: at(page),
    };
  },

  /**
   * A text to the agent's number, as Twilio posts it to the number's webhook: form-encoded, with
   * the parameters of Twilio's request to an application. `OptOutType` for a keyword Twilio acted on.
   */
  incoming(message: TwilioMessageRecord, app: TwilioAppRecord, optOutType: string | undefined): string {
    const params = new URLSearchParams({
      ToCountry: countryOf(message.to),
      ToState: "",
      SmsMessageSid: message.id,
      NumMedia: String(message.media.length),
      ToCity: "",
      FromZip: "",
      SmsSid: message.id,
      FromState: "",
      SmsStatus: "received",
      FromCity: "",
      Body: message.body,
      FromCountry: countryOf(message.from),
      To: message.to,
      MessagingServiceSid: app.messagingServiceSid,
      ToZip: "",
      NumSegments: String(message.segments),
      MessageSid: message.id,
      AccountSid: app.accountSid,
      From: message.from,
      ApiVersion: API_VERSION,
    });
    message.media.forEach((url, at) => {
      params.set(`MediaUrl${at}`, url);
      params.set(`MediaContentType${at}`, "application/octet-stream");
    });
    if (optOutType !== undefined) params.set("OptOutType", optOutType);
    return params.toString();
  },

  /** A status callback: what became of a message the agent sent. `ErrorCode` once it failed. */
  status(message: TwilioMessageRecord, accountSid: string, status: string, atMs: number): string {
    const params = new URLSearchParams({
      SmsSid: message.id,
      SmsStatus: status,
      MessageStatus: status,
      To: message.to,
      ...(message.messagingServiceSid ? { MessagingServiceSid: message.messagingServiceSid } : {}),
      MessageSid: message.id,
      AccountSid: accountSid,
      From: message.from,
      ApiVersion: API_VERSION,
    });
    if ((status === "undelivered" || status === "failed") && message.errorCode !== undefined) {
      params.set("ErrorCode", String(message.errorCode));
    }
    if (status === "delivered") {
      // The carrier's delivery report's time, as Twilio passes it on: `YYMMDDhhmm`, in UTC.
      const done = new Date(atMs).toISOString();
      params.set(
        "RawDlrDoneDate",
        `${done.slice(2, 4)}${done.slice(5, 7)}${done.slice(8, 10)}${done.slice(11, 13)}${done.slice(14, 16)}`,
      );
    }
    return params.toString();
  },

  /** A refusal, as Twilio's REST API answers it. */
  error(status: number, code: number, message: string) {
    return { code, message, more_info: moreInfo(code), status };
  },
};
