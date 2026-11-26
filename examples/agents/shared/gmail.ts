/**
 * What the Gmail reference agents do, written once against `googleapis` so each agent behaves the
 * same. Scripted, so tests can rely on it: the agent watches its inbox, and on each push lists its
 * history from the last id it handled, answering every new message once, in its thread, then
 * marking it read. A message it sent itself is never answered, and a push Pub/Sub sends again
 * finds nothing new.
 */
import type { gmail_v1 } from "googleapis";

/** What to say to an email: scripted, from its subject and its first line. */
function answer(subject: string, text: string): string {
  const first =
    text
      .split("\n")
      .find((line) => line.trim() !== "" && !line.startsWith(">"))
      ?.trim() ?? "";
  if (/invoice/i.test(text)) return "Your invoice is attached to your account page.";
  if (/refund/i.test(`${subject} ${text}`)) return "Your refund was sent today; it arrives in 3 to 5 days.";
  return `Thanks for your email about "${subject}". You wrote: ${first}`;
}

/** A header's value, the way Gmail lists them. */
const header = (message: gmail_v1.Schema$Message, name: string) =>
  message.payload?.headers?.find((each) => each.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

/** The plain text of a message: its `text/plain` part, decoded. */
function textOf(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data)
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const child of part.parts ?? []) {
    const text = textOf(child);
    if (text) return text;
  }
  return "";
}

/** A subject as a header carries it: encoded, so any language survives. */
const encoded = (subject: string) => `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;

export function gmailAgent(gmail: gmail_v1.Gmail, options: { address: string; name: string; topic: string }) {
  const own = options.address.toLowerCase();
  /** The history id the agent has handled up to. */
  let cursor: string | undefined;
  /** The messages answered so far, by id. */
  const answered = new Set<string>();
  /** Pushes are handled one at a time, in order: each lists history from where the last left off. */
  let queue: Promise<void> = Promise.resolve();

  async function reply(id: string) {
    if (answered.has(id)) return;
    answered.add(id);
    const { data: message } = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const from = header(message, "From");
    const sender = (from.match(/<([^>]+)>/)?.[1] ?? from).toLowerCase();
    if (sender === own || !message.labelIds?.includes("INBOX")) return;
    const subject = header(message, "Subject");
    const messageId = header(message, "Message-ID");
    const references = [header(message, "References"), messageId].filter(Boolean).join(" ");
    const raw = [
      `From: ${options.name} <${options.address}>`,
      `To: ${sender}`,
      `Subject: ${encoded(/^re:/i.test(subject) ? subject : `Re: ${subject}`)}`,
      `In-Reply-To: ${messageId}`,
      `References: ${references}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(answer(subject, textOf(message.payload)), "utf8").toString("base64"),
    ].join("\r\n");
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: Buffer.from(raw).toString("base64url"), threadId: message.threadId ?? null },
    });
    await gmail.users.messages.modify({ userId: "me", id, requestBody: { removeLabelIds: ["UNREAD"] } });
  }

  /** Everything new since the cursor: each added message answered, then the cursor moved on. */
  async function sync() {
    if (cursor === undefined) return;
    const from = cursor;
    let pageToken: string | undefined;
    do {
      const { data } = await gmail.users.history.list({
        userId: "me",
        startHistoryId: from,
        historyTypes: ["messageAdded"],
        labelId: "INBOX",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const entry of data.history ?? []) {
        for (const added of entry.messagesAdded ?? []) if (added.message?.id) await reply(added.message.id);
      }
      pageToken = data.nextPageToken ?? undefined;
      if (!pageToken && data.historyId) cursor = data.historyId;
    } while (pageToken);
  }

  return {
    /** Watch the inbox: pushes start, and history is read from here on. */
    async start() {
      const { data } = await gmail.users.watch({
        userId: "me",
        requestBody: { topicName: options.topic, labelIds: ["INBOX"], labelFilterBehavior: "include" },
      });
      cursor = data.historyId ?? undefined;
    },
    /** A verified push: read what changed since the last one. */
    notified() {
      queue = queue.then(sync, sync);
      return queue;
    },
  };
}
