import type { Context } from "hono";

import { type RestAnswer, restApi } from "../../../core/fake/endpoint.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import { TWILIO_IDS } from "../ids.ts";
import { API_VERSION, rfc2822, twilioPayloads } from "../payloads.ts";
import type { TwilioMessageRecord } from "../world.ts";
import { type FakeTwilioWorld, type SendInput, TwilioApiError } from "./world.ts";

/** When the fake account was made: before any test. */
const ACCOUNT_CREATED_AT = Date.parse("2026-01-01T00:00:00Z");
/** Twilio's default page, and its largest. */
const PAGE_SIZE = 50;
const PAGE_SIZE_MAX = 1000;
/** Where each request's credentials are kept for its handler: which account, and whether they are the test credentials. */
const CALLER = "twilioCaller";

interface Caller {
  readonly accountSid: string;
  readonly test: boolean;
}

/** A refusal, as Twilio answers it. */
const errorAnswer = (
  status: number,
  code: number,
  message: string,
  extra: { headers?: Record<string, string>; detail?: string } = {},
): RestAnswer => ({
  body: { ...twilioPayloads.error(status, code, message), ...(extra.detail ? { detail: extra.detail } : {}) },
  sessions: [],
  status,
  ...(extra.headers ? { headers: extra.headers } : {}),
});

/** A path's last segment, as Twilio names a resource: `SM….json`. Anything else isn't one. */
const resourceSid = (c: Context, param: string) => {
  const file = c.req.param(param) ?? "";
  return file.endsWith(".json") ? file.slice(0, -".json".length) : undefined;
};

/** `YYYY-MM-DD` as the start of that day, in UTC. */
const day = (value: string | null) => (value === null ? undefined : Date.parse(`${value}T00:00:00Z`));

/**
 * The fake Twilio REST API (API version 2010-04-01), as the `twilio` SDK calls it: form bodies,
 * HTTP basic auth with the Account SID and Auth Token or an API key and its secret, and Twilio's
 * test credentials, with which only sending works and nothing is sent.
 */
export function createTwilioApi(
  context: DriverContext,
  world: FakeTwilioWorld,
  keys: { readonly apiKeySid: string; readonly testAccountSid: string },
) {
  const { ids } = context;
  const { store } = world;

  const notFound = (c: Context) =>
    errorAnswer(
      404,
      20404,
      `The requested resource ${new URL(c.req.url).pathname.replace(/^\/twilio/, "")} was not found`,
    );
  const caller = (c: Context) => c.get(CALLER as never) as Caller;

  /** Who the credentials are: the account's own, its API key, or its test credentials. */
  const callerOf = (username: string, password: string): Caller | undefined => {
    const { accountSid } = store.app;
    if (username === accountSid && constantTimeEqual(password, context.secret("authToken"))) {
      return { accountSid, test: false };
    }
    if (username === keys.apiKeySid && constantTimeEqual(password, context.secret("apiKeySecret"))) {
      return { accountSid, test: false };
    }
    if (username === keys.testAccountSid && constantTimeEqual(password, context.secret("testAuthToken"))) {
      return { accountSid: keys.testAccountSid, test: true };
    }
    return undefined;
  };

  const { api, endpoint, finish } = restApi(context, {
    driver: "twilio",
    authorize(c) {
      const header = c.req.header("authorization") ?? "";
      const [scheme, encoded = ""] = header.split(" ");
      const decoded = scheme?.toLowerCase() === "basic" ? Buffer.from(encoded, "base64").toString("utf8") : "";
      const split = decoded.indexOf(":");
      const who = split < 0 ? undefined : callerOf(decoded.slice(0, split), decoded.slice(split + 1));
      const account = c.req.param("account") ?? resourceSid(c, "accountFile");
      // Credentials for one account don't open another's resources.
      if (!who || (account !== undefined && account !== who.accountSid)) {
        return errorAnswer(401, 20003, "Authenticate", {
          headers: { "www-authenticate": 'Basic realm="Twilio API"' },
          detail: "Your AccountSid or AuthToken was incorrect.",
        });
      }
      c.set(CALLER as never, who as never);
      return undefined;
    },
    refusal: (error) =>
      error instanceof TwilioApiError ? errorAnswer(error.status, error.code, error.message) : undefined,
    decorate: (answer) => ({
      ...answer,
      headers: { ...answer.headers, "twilio-request-id": ids.next(TWILIO_IDS.request) },
    }),
    // A form Twilio can't read is a request without parameters.
    invalidJson: () => errorAnswer(400, 21604, "A 'To' phone number is required."),
    notFound,
  });

  /** The test credentials reach nothing but sending. */
  const live = (c: Context) => {
    if (caller(c).test) throw new TwilioApiError(403, 20008, "Resource not accessible with Test Account Credentials");
  };

  const text = (body: Record<string, unknown>, name: string): string | undefined =>
    typeof body[name] === "string" ? (body[name] as string) : undefined;

  /** `POST …/Messages.json`'s parameters as the world takes them. A form sends `MediaUrl` once per URL. */
  const sendInput = (body: Record<string, unknown>, form: URLSearchParams): SendInput => ({
    to: text(body, "To")?.trim(),
    from: text(body, "From")?.trim() || undefined,
    messagingServiceSid: text(body, "MessagingServiceSid") || undefined,
    body: text(body, "Body") ?? "",
    media: form.getAll("MediaUrl"),
    statusCallback: text(body, "StatusCallback") || undefined,
  });

  const messagesPath = (accountSid: string) => `/${API_VERSION}/Accounts/${accountSid}/Messages.json`;

  /** A message of the account's, by the SID in the path. */
  const messageOf = (c: Context): TwilioMessageRecord => {
    const sid = resourceSid(c, "messageFile");
    const message = sid === undefined ? undefined : store.messages.find(sid);
    if (!message || message.accountSid !== store.app.accountSid) throw notFoundError(c);
    return message;
  };
  const notFoundError = (c: Context) => {
    const answer = notFound(c).body as { message: string };
    return new TwilioApiError(404, 20404, answer.message);
  };

  endpoint(
    "post",
    "/2010-04-01/Accounts/:account/Messages.json",
    "messages.create",
    async (c, body) => {
      const input = sendInput(body, new URLSearchParams(await c.req.text()));
      const who = caller(c);
      if (who.test) return { body: world.testSend(input, who.accountSid), sessions: [], status: 201 };
      const { message, queued } = world.appSends(input);
      return { body: queued, sessions: [world.sessionOf(message)], status: 201 };
    },
    { form: true },
  );

  endpoint("get", "/2010-04-01/Accounts/:account/Messages.json", "messages.list", (c) => {
    live(c);
    const query = new URL(c.req.url).searchParams;
    const to = query.get("To");
    const from = query.get("From");
    const on = day(query.get("DateSent"));
    const before = day(query.get("DateSent<"));
    const after = day(query.get("DateSent>"));
    const size = Math.min(Math.max(Number(query.get("PageSize") ?? PAGE_SIZE) || PAGE_SIZE, 1), PAGE_SIZE_MAX);
    const page = Math.max(Number(query.get("Page") ?? 0) || 0, 0);
    const listed = store.messages
      .values()
      .filter((message) => message.accountSid === store.app.accountSid)
      .filter((message) => to === null || message.to === to)
      .filter((message) => from === null || message.from === from)
      .filter((message) => {
        const sent = message.sentAt ?? message.createdAt;
        return (
          (on === undefined || (sent >= on && sent < on + 86_400_000)) &&
          (before === undefined || sent < before + 86_400_000) &&
          (after === undefined || sent >= after)
        );
      })
      // Newest first, as Twilio lists: the later of two made in the same millisecond first too.
      .reverse()
      .sort((a, b) => b.createdAt - a.createdAt);
    const items = listed.map((message) => twilioPayloads.message(message, store.app.accountSid));
    return {
      body: twilioPayloads.page(messagesPath(store.app.accountSid), "messages", items, page, size, query),
      sessions: listed.map(world.sessionOf),
    };
  });

  endpoint("get", "/2010-04-01/Accounts/:account/Messages/:messageFile", "messages.fetch", (c) => {
    live(c);
    const message = messageOf(c);
    return { body: twilioPayloads.message(message, store.app.accountSid), sessions: [world.sessionOf(message)] };
  });

  endpoint(
    "post",
    "/2010-04-01/Accounts/:account/Messages/:messageFile",
    "messages.update",
    (c, body) => {
      live(c);
      const message = messageOf(c);
      // Only redacting: the body can be emptied, and never changed.
      if (text(body, "Body") !== "") {
        throw new TwilioApiError(400, 20001, "Body can only be updated to an empty string, which redacts the message.");
      }
      message.body = "";
      message.updatedAt = context.clock();
      return { body: twilioPayloads.message(message, store.app.accountSid), sessions: [world.sessionOf(message)] };
    },
    { form: true },
  );

  endpoint("delete", "/2010-04-01/Accounts/:account/Messages/:messageFile", "messages.remove", (c) => {
    live(c);
    const message = messageOf(c);
    const session = world.sessionOf(message);
    store.messages.remove(message.id);
    return { body: undefined, sessions: [session], status: 204 };
  });

  endpoint("get", "/2010-04-01/Accounts/:account/IncomingPhoneNumbers.json", "incomingPhoneNumbers.list", (c) => {
    live(c);
    const query = new URL(c.req.url).searchParams;
    const { app } = store;
    const wanted = query.get("PhoneNumber");
    const numbers =
      wanted === null || wanted === app.number
        ? [
            {
              account_sid: app.accountSid,
              address_requirements: "none",
              address_sid: null,
              api_version: API_VERSION,
              beta: false,
              bundle_sid: null,
              capabilities: { fax: false, mms: true, sms: true, voice: true },
              date_created: rfc2822(ACCOUNT_CREATED_AT),
              date_updated: rfc2822(ACCOUNT_CREATED_AT),
              emergency_address_sid: null,
              emergency_address_status: "unregistered",
              emergency_status: "Inactive",
              friendly_name: app.number,
              identity_sid: null,
              origin: "twilio",
              phone_number: app.number,
              sid: app.id,
              sms_application_sid: null,
              sms_fallback_method: "POST",
              sms_fallback_url: null,
              sms_method: "POST",
              sms_url: context.webhookUrl ?? null,
              status: "in-use",
              status_callback: null,
              status_callback_method: "POST",
              subresource_uris: {
                assigned_add_ons: `/${API_VERSION}/Accounts/${app.accountSid}/IncomingPhoneNumbers/${app.id}/AssignedAddOns.json`,
              },
              trunk_sid: null,
              type: "local",
              uri: `/${API_VERSION}/Accounts/${app.accountSid}/IncomingPhoneNumbers/${app.id}.json`,
              voice_application_sid: null,
              voice_caller_id_lookup: false,
              voice_fallback_method: "POST",
              voice_fallback_url: null,
              voice_method: "POST",
              voice_receive_mode: "voice",
              voice_url: null,
            },
          ]
        : [];
    const path = `/${API_VERSION}/Accounts/${app.accountSid}/IncomingPhoneNumbers.json`;
    return { body: twilioPayloads.page(path, "incoming_phone_numbers", numbers, 0, PAGE_SIZE, query), sessions: [] };
  });

  endpoint("get", "/2010-04-01/Accounts/:accountFile", "accounts.fetch", (c) => {
    live(c);
    const { app } = store;
    const base = `/${API_VERSION}/Accounts/${app.accountSid}`;
    return {
      body: {
        auth_token: context.secret("authToken"),
        date_created: rfc2822(ACCOUNT_CREATED_AT),
        date_updated: rfc2822(ACCOUNT_CREATED_AT),
        friendly_name: app.name,
        owner_account_sid: app.accountSid,
        sid: app.accountSid,
        status: "active",
        subresource_uris: {
          messages: `${base}/Messages.json`,
          incoming_phone_numbers: `${base}/IncomingPhoneNumbers.json`,
        },
        type: "Full",
        uri: `${base}.json`,
      },
      sessions: [],
    };
  });

  return finish();
}
