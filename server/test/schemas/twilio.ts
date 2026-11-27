import { Ajv, type ValidateFunction } from "ajv";

import { openApiChecks } from "./openapi.ts";
import description from "./twilio-api-v2010.json" with { type: "json" };

/**
 * Twilio's own description of its REST API (`twilio/twilio-oai`, `twilio_api_v2010.json`, pinned by
 * `scripts/pinned-schema.ts`), as validators. Exit check 10.2 holds every answer of the fake to it.
 * The description is OpenAPI 3.0: its schemas are JSON Schema draft 4 with `nullable`, which Ajv
 * reads, and Twilio's own formats, added here.
 *
 * It describes no webhook. A webhook's parameters are held to the Message resource's schemas of the
 * fields they carry (`MessageSid` to `sid`, `SmsStatus` to `status`, …), and to the parameters
 * Twilio's docs list for each kind: no more, and none missing.
 */
type Json = Record<string, unknown>;

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
// Twilio's formats, as its description uses them.
ajv.addFormat("phone-number", /^(?:\+[1-9]\d{1,14}|[a-z]+:\+?[\w.@-]+|[A-Za-z0-9 ]{1,11})$/);
ajv.addFormat("date-time-rfc-2822", /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
ajv.addFormat("currency", /^[A-Z]{3}$/);
ajv.addFormat("uri-map", true);
ajv.addFormat("uri", /^(?:[a-z][a-z0-9+.-]*:|\/)/i);
ajv.addFormat("date-time", true);
ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
ajv.addSchema(description as Json, "twilio");
const checks = openApiChecks(ajv, "twilio", description, "Twilio", { strictStatus: true });

/** What Twilio's description says about one answer of the API: nothing when it fits. */
export const twilioResponseProblems = checks.responseProblems;

/** The Message resource's schema of one field, by its name in the description. */
const field = (name: string) => ({ $ref: `twilio#/components/schemas/api.v2010.account.message/properties/${name}` });
/** A count, as a form carries it. */
const count = { type: "string", pattern: "^\\d+$" };
/** The geographic fields Twilio adds from the numbers, empty where it doesn't know. */
const place = { type: "string" };

/** Each parameter of a webhook, and the Message field whose schema holds it. */
const PARAMETERS: Readonly<Record<string, Json>> = {
  MessageSid: field("sid"),
  SmsSid: field("sid"),
  SmsMessageSid: field("sid"),
  AccountSid: field("account_sid"),
  MessagingServiceSid: field("messaging_service_sid"),
  From: field("from"),
  To: { type: "string", format: "phone-number" },
  Body: field("body"),
  NumMedia: count,
  NumSegments: count,
  SmsStatus: { $ref: "twilio#/components/schemas/message_enum_status" },
  MessageStatus: { $ref: "twilio#/components/schemas/message_enum_status" },
  ApiVersion: { const: "2010-04-01" },
  ErrorCode: { type: "string", pattern: "^\\d{5}$" },
  OptOutType: { enum: ["STOP", "START", "HELP"] },
  RawDlrDoneDate: { type: "string", pattern: "^\\d{10}$" },
  FromCity: place,
  FromState: place,
  FromZip: place,
  FromCountry: place,
  ToCity: place,
  ToState: place,
  ToZip: place,
  ToCountry: place,
};

const webhook = (required: readonly string[], allowed: readonly string[]) =>
  ajv.compile({
    type: "object",
    required,
    properties: Object.fromEntries(allowed.map((name) => [name, PARAMETERS[name]])),
    patternProperties: {
      "^MediaUrl\\d+$": { type: "string", format: "uri" },
      "^MediaContentType\\d+$": { type: "string" },
    },
    additionalProperties: false,
  });

/** Twilio's request to the application of a number that was texted, and its status callbacks. */
const WEBHOOKS: Readonly<Record<string, ValidateFunction>> = {
  message: webhook(
    [
      "MessageSid",
      "SmsSid",
      "SmsMessageSid",
      "AccountSid",
      "From",
      "To",
      "Body",
      "NumMedia",
      "NumSegments",
      "SmsStatus",
      "ApiVersion",
    ],
    Object.keys(PARAMETERS).filter((name) => !["MessageStatus", "ErrorCode", "RawDlrDoneDate"].includes(name)),
  ),
  status: webhook(
    ["MessageSid", "SmsSid", "AccountSid", "From", "To", "MessageStatus", "SmsStatus", "ApiVersion"],
    [
      "MessageSid",
      "SmsSid",
      "AccountSid",
      "MessagingServiceSid",
      "From",
      "To",
      "MessageStatus",
      "SmsStatus",
      "ApiVersion",
      "ErrorCode",
      "RawDlrDoneDate",
    ],
  ),
};

/** What it says about one webhook: a text to the agent's number (`message`), or a status callback (`status`). */
export function twilioWebhookProblems(type: string, payload: unknown): string[] {
  return checks.problemsOf(WEBHOOKS[type], payload, `webhook ${type}`);
}
