import type { MimeHeader } from "../../core/email/mime.ts";
import type { GmailHistoryRecord, GmailLabelRecord, GmailMessageRecord, GoogleEmailRecord } from "./world.ts";

/**
 * What the Google fake sends, in the shapes Gmail and Pub/Sub send it: Gmail's resources
 * (`Message`, `MessagePart`, `Thread`, `Label`, `History`) as its discovery document describes
 * them, and Pub/Sub's push body. Exit check 9.2 holds them to the pinned document.
 */
type Json = Record<string, unknown>;

/** How Gmail asks for a message (`format`). */
export type MessageFormat = "full" | "metadata" | "minimal" | "raw";

const utf8 = (text: string) => Buffer.from(text, "utf8");

/** A body as Gmail gives it: its size in bytes, and its content in base64url. */
const bodyOf = (content: string | undefined) =>
  content === undefined ? { size: 0 } : { size: utf8(content).length, data: utf8(content).toString("base64url") };

/** One leaf of a message: its text or its HTML, with the headers that say which. */
function leaf(partId: string, mimeType: "text/plain" | "text/html", content: string, headers?: readonly MimeHeader[]) {
  return {
    partId,
    mimeType,
    filename: "",
    headers: headers ?? [
      { name: "Content-Type", value: `${mimeType}; charset="UTF-8"` },
      { name: "Content-Transfer-Encoding", value: "quoted-printable" },
    ],
    body: bodyOf(content),
  };
}

/**
 * The message's structure as `format=full` shows it: one part for a text-only or HTML-only email,
 * `multipart/alternative` with both otherwise. The top level carries the message's own headers.
 */
function payloadOf(email: GoogleEmailRecord, headers: readonly MimeHeader[]): Json {
  if (email.text !== undefined && email.html !== undefined) {
    return {
      partId: "",
      mimeType: "multipart/alternative",
      filename: "",
      headers,
      body: { size: 0 },
      parts: [leaf("0", "text/plain", email.text), leaf("1", "text/html", email.html)],
    };
  }
  const html = email.text === undefined;
  return leaf("", html ? "text/html" : "text/plain", (html ? email.html : email.text) ?? "", headers);
}

/** Gmail's snippet: the start of the text, whitespace folded, HTML-escaped as Gmail escapes it. */
function snippetOf(email: GoogleEmailRecord): string {
  const text = (email.text ?? (email.html ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return text
    .slice(0, 200)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const googlePayloads = {
  /** A message as `users.messages.get` answers it, in the format asked for. */
  message(
    message: GmailMessageRecord,
    email: GoogleEmailRecord,
    format: MessageFormat,
    metadataHeaders: readonly string[] = [],
  ): Json {
    const raw = email.raw ?? "";
    const base = {
      id: message.id,
      threadId: message.threadId,
      labelIds: [...message.labels],
      snippet: snippetOf(email),
      sizeEstimate: utf8(raw).length,
      historyId: message.historyId,
      internalDate: String(message.internalDate),
    };
    if (format === "minimal") return base;
    if (format === "raw") return { ...base, raw: utf8(raw).toString("base64url") };
    if (format === "metadata") {
      const wanted = metadataHeaders.map((name) => name.toLowerCase());
      const headers =
        wanted.length === 0
          ? email.headers
          : email.headers.filter((header) => wanted.includes(header.name.toLowerCase()));
      return { ...base, payload: { mimeType: payloadOf(email, []).mimeType, headers } };
    }
    return { ...base, payload: payloadOf(email, email.headers) };
  },

  /** A message as lists name it: its id and its thread's. */
  ref: (message: GmailMessageRecord) => ({ id: message.id, threadId: message.threadId }),

  /** A message as history entries carry it: with its labels then. */
  historyMessage: (entry: GmailHistoryRecord) => ({
    id: entry.message,
    threadId: entry.threadId,
    labelIds: [...entry.labelsAfter],
  }),

  /** One history record, as `users.history.list` lists it. */
  history(entry: GmailHistoryRecord): Json {
    const message = googlePayloads.historyMessage(entry);
    const ref = { id: entry.message, threadId: entry.threadId };
    switch (entry.kind) {
      case "messageAdded":
        return { id: entry.id, messages: [ref], messagesAdded: [{ message }] };
      case "messageDeleted":
        return { id: entry.id, messages: [ref], messagesDeleted: [{ message }] };
      case "labelAdded":
        return { id: entry.id, messages: [ref], labelsAdded: [{ message, labelIds: [...entry.labels] }] };
      case "labelRemoved":
        return { id: entry.id, messages: [ref], labelsRemoved: [{ message, labelIds: [...entry.labels] }] };
    }
  },

  /** A label, with its counts when one is read on its own. */
  label(label: GmailLabelRecord, counts?: { messages: GmailMessageRecord[]; threads: Set<string> }): Json {
    const shown = {
      id: label.id,
      name: label.name,
      type: label.type,
      ...(label.messageListVisibility ? { messageListVisibility: label.messageListVisibility } : {}),
      ...(label.labelListVisibility ? { labelListVisibility: label.labelListVisibility } : {}),
    };
    if (!counts) return shown;
    const unread = counts.messages.filter((message) => message.labels.includes("UNREAD"));
    return {
      ...shown,
      messagesTotal: counts.messages.length,
      messagesUnread: unread.length,
      threadsTotal: counts.threads.size,
      threadsUnread: new Set(unread.map((message) => message.threadId)).size,
    };
  },

  /**
   * A Pub/Sub push, in the wrapped format: Gmail's notification in `message.data`, base64 JSON,
   * with the message's id and publish time each under both of Pub/Sub's names.
   */
  push(
    notification: { emailAddress: string; historyId: string },
    messageId: string,
    publishTime: string,
    subscription: string,
  ): Json {
    return {
      message: {
        data: Buffer.from(JSON.stringify(notification)).toString("base64"),
        messageId,
        message_id: messageId,
        publishTime,
        publish_time: publishTime,
      },
      subscription,
    };
  },

  /** Google's error envelope, as every Google API answers a refusal. */
  error: (code: number, message: string, reason: string, status: string, extra: Json = {}): Json => ({
    error: { code, message, errors: [{ message, domain: "global", reason, ...extra }], status },
  }),
};
