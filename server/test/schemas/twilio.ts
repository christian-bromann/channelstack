import { Ajv, type ValidateFunction } from "ajv";

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
const compiled = new Map<string, ValidateFunction | undefined>();
const schemaAt = (pointer: string) => {
  if (!compiled.has(pointer)) compiled.set(pointer, ajv.getSchema(`twilio#/${pointer}`));
  return compiled.get(pointer);
};
const pointerPart = (part: string) => part.replaceAll("~", "~0").replaceAll("/", "~1");

const paths = description.paths as Record<string, Record<string, { responses?: Record<string, Json> }>>;
/** Each path template as a pattern: `/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json` matches a message's. */
const templates = Object.keys(paths).map((template) => ({
  template,
  pattern: new RegExp(`^${template.replace(/\./g, "\\.").replace(/\{[^}]+\}/g, "[^/]+")}$`),
  literal: template.split("{").length,
}));

const problemsOf = (validate: ValidateFunction | undefined, value: unknown, where: string): string[] => {
  if (!validate) return [`${where}: Twilio's description has no schema for it`];
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${where}: ${error.instancePath || "/"} ${error.message}`);
};

/** What Twilio's description says about one answer of the API: nothing when it fits. */
export function twilioResponseProblems(method: string, path: string, status: number, body: unknown): string[] {
  const match = templates.filter(({ pattern }) => pattern.test(path)).sort((a, b) => a.literal - b.literal)[0];
  if (!match) return [`${method} ${path}: not in Twilio's description`];
  const operation = paths[match.template]?.[method.toLowerCase()];
  if (!operation) return [`${method} ${path}: Twilio's description has no ${method} for ${match.template}`];
  const response = operation.responses?.[String(status)] as { content?: Record<string, unknown> } | undefined;
  // A refusal, or an answer the description lists without a body (a 204), has nothing to hold it to.
  if (status >= 400) return [];
  if (!response) return [`${method} ${path}: Twilio's description has no ${status} answer`];
  if (response.content?.["application/json"] === undefined) return [];
  const pointer = [
    "paths",
    match.template,
    method.toLowerCase(),
    "responses",
    String(status),
    "content",
    "application/json",
    "schema",
  ]
    .map(pointerPart)
    .join("/");
  return problemsOf(schemaAt(pointer), body, `${method} ${path} ${status}`);
}

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
  return problemsOf(WEBHOOKS[type], payload, `webhook ${type}`);
}
