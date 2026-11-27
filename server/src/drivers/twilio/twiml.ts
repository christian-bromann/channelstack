import { XMLParser, XMLValidator } from "fast-xml-parser";

/** One `<Message>` of a TwiML answer: what Twilio sends for it. */
export interface TwimlMessage {
  /** Its `to` and `from` attributes; without them, back to the sender, from the number texted. */
  readonly to: string | undefined;
  readonly from: string | undefined;
  readonly body: string;
  readonly media: readonly string[];
  readonly statusCallback: string | undefined;
}

/** TwiML Twilio can't act on: its error 12100 (the document doesn't parse) or 12200 (not TwiML Twilio knows). */
export class TwimlError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // `&amp;` and the other XML entities; never HTML's, and never one a document declares.
  processEntities: true,
  htmlEntities: false,
  isArray: (name) => ["Message", "Body", "Media"].includes(name),
});

const textOf = (node: unknown): string =>
  typeof node === "string"
    ? node
    : typeof node === "object" && node !== null
      ? String((node as Record<string, unknown>)["#text"] ?? "")
      : "";

/**
 * The messages a TwiML answer to a messaging webhook sends, in order: each `<Message>`, its text
 * or its `<Body>` and `<Media>`. An empty answer, or `<Response/>`, sends nothing. A document with a
 * DTD is refused rather than read: Twilio's TwiML has none.
 */
export function readTwiml(xml: string): TwimlMessage[] {
  if (xml.trim() === "") return [];
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new TwimlError(12100, "Document parse failure: a DTD isn't TwiML");
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new TwimlError(12100, `Document parse failure: ${valid.err.msg}`);
  const document = parser.parse(xml) as Record<string, unknown>;
  const response = document.Response;
  if (response === undefined) throw new TwimlError(12200, "The root element must be <Response>");
  if (typeof response !== "object" || response === null) return [];
  const messages = ((response as Record<string, unknown>).Message ?? []) as unknown[];
  return messages.map((node) => {
    const message = (typeof node === "object" && node !== null ? node : { "#text": node }) as Record<string, unknown>;
    const bodies = (message.Body as unknown[] | undefined)?.map(textOf) ?? [];
    const attribute = (name: string) =>
      typeof message[`@${name}`] === "string" ? (message[`@${name}`] as string) : undefined;
    return {
      to: attribute("to"),
      from: attribute("from"),
      body: bodies.length > 0 ? bodies.join("") : textOf(message),
      media: ((message.Media as unknown[] | undefined) ?? []).map(textOf),
      statusCallback: attribute("statusCallback"),
    };
  });
}
