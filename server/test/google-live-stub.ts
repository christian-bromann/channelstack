import { mimeHeaders } from "../src/core/email/mime.ts";
import { randomString } from "../src/core/secrets/index.ts";

/**
 * A stand-in for real Gmail in unit tests of live mode: mailboxes in memory, each with a refresh
 * token from one OAuth client, that answer the calls the live backend makes in Gmail's shapes, and
 * record each with whose mailbox made it. An email one mailbox sends reaches the others it names.
 * `agentReplies` sends the agent's answer, as the agent would.
 */
export interface GoogleStub {
  readonly url: string;
  fetch: typeof fetch;
  readonly client: { id: string; secret: string };
  readonly agent: Mailbox;
  mailbox(name: string, address: string): Mailbox;
  readonly calls: Array<{ method: string; path: string; as: string }>;
  /** What every mailbox sent, oldest first. */
  readonly sent: Sent[];
  /** The agent's answer to an email, with a `Reply-To` when given. */
  agentReplies(to: Sent, text: string, also?: { replyTo?: string }): void;
}

interface Mailbox {
  name: string;
  address: string;
  refreshToken: string;
  messages: Array<{ id: string; threadId: string; sent: Sent; labels: string[] }>;
  labels: Array<{ id: string; name: string }>;
  trashed: string[];
}
export interface Sent {
  id: string;
  from: string;
  to: string[];
  subject: string;
  messageId: string;
  inReplyTo: string | undefined;
  replyTo?: string;
  headers: Record<string, string>;
  text: string;
  at: number;
}

const hex = "0123456789abcdef";
const id = () => `19${randomString(14, hex)}`;
const address = (field: string) => (field.match(/<([^>]+)>/)?.[1] ?? field).trim().toLowerCase();

export function googleStub(): GoogleStub {
  const url = "https://google.stub";
  const client = {
    id: `${randomString(12, "0123456789")}-stub.apps.googleusercontent.com`,
    secret: `GOCSPX-${randomString(28, hex)}`,
  };
  const mailboxes: Mailbox[] = [];
  const access = new Map<string, Mailbox>();
  const sent: Sent[] = [];
  const calls: GoogleStub["calls"] = [];
  const mailbox = (name: string, at: string) => {
    const made: Mailbox = {
      name,
      address: at,
      refreshToken: `1//0${randomString(60, hex)}`,
      messages: [],
      labels: [],
      trashed: [],
    };
    mailboxes.push(made);
    return made;
  };
  const agent = mailbox("agent", "my-agent@agent.example.org");
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const notFound = () =>
    json({ error: { code: 404, message: "Requested entity was not found.", errors: [{ reason: "notFound" }] } }, 404);

  /** An email from `by` reaches each mailbox it names, in the thread its `In-Reply-To` names there. */
  const deliver = (by: Mailbox, email: Sent, threadId?: string) => {
    sent.push(email);
    by.messages.push({ id: email.id, threadId: threadId ?? id(), sent: email, labels: ["SENT"] });
    for (const to of mailboxes.filter((each) => email.to.includes(each.address) && each !== by)) {
      const answered = to.messages.find((message) => message.sent.messageId === email.inReplyTo);
      to.messages.push({ id: id(), threadId: answered?.threadId ?? id(), sent: email, labels: ["INBOX", "UNREAD"] });
    }
  };
  const wire = (message: Mailbox["messages"][number], format: string) => ({
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labels,
    internalDate: String(message.sent.at),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: message.sent.from },
        { name: "To", value: message.sent.to.join(", ") },
        { name: "Subject", value: message.sent.subject },
        { name: "Message-ID", value: message.sent.messageId },
        ...(message.sent.inReplyTo ? [{ name: "In-Reply-To", value: message.sent.inReplyTo }] : []),
        ...(message.sent.replyTo ? [{ name: "Reply-To", value: message.sent.replyTo }] : []),
      ],
      ...(format === "full" ? { body: { data: Buffer.from(message.sent.text).toString("base64url") } } : {}),
    },
  });

  const stub: GoogleStub = {
    url,
    client,
    agent,
    mailbox,
    calls,
    sent,
    agentReplies(to, text, also = {}) {
      deliver(agent, {
        ...(also.replyTo ? { replyTo: also.replyTo } : {}),
        id: id(),
        from: `my-agent <${agent.address}>`,
        to: [address(to.from)],
        subject: `Re: ${to.subject}`,
        messageId: `<${randomString(16, hex)}@mail.gmail.com>`,
        inReplyTo: to.messageId,
        headers: {},
        text,
        at: Date.now(),
      });
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(String(input), init);
      const { pathname, searchParams } = new URL(request.url);
      if (pathname === "/token") {
        const form = new URLSearchParams(await request.text());
        const owner = mailboxes.find((each) => each.refreshToken === form.get("refresh_token"));
        calls.push({ method: "POST", path: pathname, as: owner?.name ?? "nobody" });
        if (form.get("client_id") !== client.id || form.get("client_secret") !== client.secret) {
          return json({ error: "invalid_client", error_description: "The OAuth client was not found." }, 401);
        }
        if (!owner)
          return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
        const token = `ya29.${randomString(40, hex)}`;
        access.set(token, owner);
        return json({ access_token: token, expires_in: 3599, token_type: "Bearer" });
      }
      const by = access.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
      calls.push({ method: request.method, path: pathname, as: by?.name ?? "nobody" });
      if (!by)
        return json({ error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } }, 401);
      const route = pathname.replace(/^\/gmail\/v1\/users\/me/, "");
      const body = request.method === "POST" ? JSON.parse((await request.text()) || "{}") : {};
      if (route === "/profile")
        return json({ emailAddress: by.address, messagesTotal: by.messages.length, historyId: "1" });
      if (route === "/labels" && request.method === "GET") return json({ labels: by.labels });
      if (route === "/labels") {
        const label = { id: `Label_${by.labels.length + 1}`, name: body.name };
        by.labels.push(label);
        return json(label);
      }
      if (route === "/messages/send") {
        const raw = Buffer.from(body.raw, "base64url").toString("utf8");
        const header = (name: string) => mimeHeaders(raw).find((each) => each.name.toLowerCase() === name)?.value ?? "";
        const email: Sent = {
          id: id(),
          from: header("from"),
          to: header("to").split(",").map(address).filter(Boolean),
          subject: header("subject"),
          // Gmail keeps the Message-ID the sender gave.
          messageId: header("message-id"),
          inReplyTo: header("in-reply-to") || undefined,
          headers: Object.fromEntries(mimeHeaders(raw).map(({ name, value }) => [name.toLowerCase(), value])),
          text: raw.slice(raw.search(/\r?\n\r?\n/)).trim(),
          at: Date.now(),
        };
        deliver(by, email, body.threadId);
        const own = by.messages.at(-1) as Mailbox["messages"][number];
        return json({ id: own.id, threadId: own.threadId, labelIds: own.labels });
      }
      if (route === "/messages" || route === "/threads") {
        const q = searchParams.get("q") ?? "";
        const from = /from:(\S+)/.exec(q)?.[1];
        const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
        const messageId = /rfc822msgid:(\S+)/.exec(q)?.[1];
        const label = searchParams.get("labelIds");
        const found = by.messages.filter(
          (message) =>
            (from === undefined || address(message.sent.from) === from) &&
            message.sent.at >= after &&
            (messageId === undefined || message.sent.messageId === `<${messageId}>`) &&
            (label === null || message.labels.includes(label)),
        );
        if (route === "/threads")
          return json({ threads: [...new Set(found.map((m) => m.threadId))].map((thread) => ({ id: thread })) });
        return json({
          messages: found.map(({ id: message, threadId }) => ({ id: message, threadId })),
          resultSizeEstimate: found.length,
        });
      }
      const message = /^\/messages\/([^/]+)$/.exec(route);
      if (message) {
        const found = by.messages.find((each) => each.id === message[1]);
        return found ? json(wire(found, searchParams.get("format") ?? "full")) : notFound();
      }
      const thread = /^\/threads\/([^/]+)(?:\/(modify|trash))?$/.exec(route);
      if (thread) {
        const messages = by.messages.filter((each) => each.threadId === thread[1]);
        if (messages.length === 0) return notFound();
        if (thread[2] === "modify") for (const each of messages) each.labels.push(...(body.addLabelIds ?? []));
        if (thread[2] === "trash") by.trashed.push(thread[1] as string);
        return json({ id: thread[1], messages: messages.map((each) => wire(each, "minimal")) });
      }
      return notFound();
    }) as typeof fetch,
  };
  return stub;
}
