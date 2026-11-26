import { randomUUID } from "node:crypto";

import type { Clock } from "../../../core/clock/index.ts";
import {
  domainOf,
  emailAuthor,
  localPartOf,
  type Mailbox,
  messageId,
  messageIdsIn,
  parseAddresses,
  replyOf,
  threadOf,
} from "../../../core/email/index.ts";
import { composeMime } from "../../../core/email/mime.ts";
import type { EmailMessageInput } from "../../../core/email/routes.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import { LivePeople } from "../../../core/people/index.ts";
import { fakeActorInLiveWorld, liveMisconfigured } from "../../../core/reality/index.ts";
import { Registry } from "../../../core/registry/index.ts";
import type { LiveContext } from "../../../core/router/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { GoogleWorld } from "../backend.ts";
import { GoogleStore } from "../fake/store.ts";
import type { GoogleEmailRecord, GoogleUserRecord } from "../world.ts";
import type { GoogleRestClient } from "./client.ts";
import { checkGoogleCredential, identifyGoogle } from "./identity.ts";

/** Reading the people's mail again more often than this is a waste: the agent takes seconds to answer. */
const READ_CACHE_MS = 1_000;
/** How far Gmail's clock may be from ours: `after:` counts in seconds. */
const CLOCK_SKEW_MS = 5_000;

interface WirePart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: WirePart[];
}
interface WireMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: WirePart;
}

/** A part's text of the given type, decoded. */
function partText(part: WirePart | undefined, type: string): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === type && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const child of part.parts ?? []) {
    const found = partText(child, type);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The live Google world: the agent's mailbox is a real Gmail account, and each person is an account
 * of their own (a refresh token from the agent's OAuth client). A person's email goes out through
 * Gmail, from their account; the agent's answers are read back from each person's mail. Every
 * thread a run touches is labelled with its tag in both mailboxes, so its session, or the sweep,
 * trashes it. channelstack never pushes to the agent: Gmail does.
 */
export function createLiveGoogleWorld(deps: {
  client: GoogleRestClient;
  live: LiveContext;
  clock: Clock;
  appName: string;
}): GoogleWorld & {
  ready(): Promise<void>;
  release(session: string): void;
  credential(owner: string, session: string): LiveCredential | undefined;
} {
  const { client, live, clock } = deps;
  const store = new GoogleStore(new Registry());
  const people = new LivePeople();
  const read = new Map<string, number>();
  /** When each session's first person joined: older mail in their mailboxes is an earlier run's. */
  const since = new Map<string, number>();
  /** Each mailbox's label for this run, made once. */
  const labels = new Map<LiveCredential, Promise<string>>();
  /** The threads labelled and on the ledger, by mailbox. */
  const tagged = new Set<string>();
  /** An email's thread in each person's mailbox: a reply there names it. */
  const gmailThread = new Map<string, string>();
  /** What people sent whose copy in the agent's mailbox isn't labelled yet, by `Message-ID`. */
  const untagged = new Map<string, string>();
  let app: LiveCredential | undefined;

  /** Everyone an email goes to must be at an allowlisted address: sent mail can't be taken back. */
  const allowed = (mailboxes: readonly Mailbox[]) => {
    for (const { address } of mailboxes) live.allowlist.assert(address, `the address ${address}`);
  };

  /** The run's label in a mailbox: `channelstack-run-…`, hidden, made the first time it's needed. */
  const runLabel = (credential: LiveCredential) => {
    let made = labels.get(credential);
    if (!made) {
      made = (async () => {
        const { labels: existing = [] } = await client.call<{ labels?: Array<{ id: string; name: string }> }>(
          credential,
          "GET",
          "gmail/v1/users/me/labels",
        );
        const found = existing.find((label) => label.name === live.tag);
        if (found) return found.id;
        const created = await client.call<{ id: string }>(credential, "POST", "gmail/v1/users/me/labels", {
          name: live.tag,
          labelListVisibility: "labelHide",
          messageListVisibility: "hide",
        });
        return created.id;
      })();
      made.catch(() => labels.delete(credential));
      labels.set(credential, made);
    }
    return made;
  };

  /** Label a thread with the run's tag, and put it on the ledger, once per mailbox. */
  const tag = async (session: string, credential: LiveCredential, mailbox: string, thread: string, name: string) => {
    const key = `${mailbox} ${thread}`;
    if (tagged.has(key)) return;
    tagged.add(key);
    await client.call(credential, "POST", `gmail/v1/users/me/threads/${thread}/modify`, {
      addLabelIds: [await runLabel(credential)],
    });
    live.ledger.record({
      channel: "google",
      kind: "thread",
      ref: { thread, name: `${live.tag} ${name}` },
      workspace: mailbox,
      by: credential.owner,
      session,
    });
  };

  /** Keep what was read or sent in the mirror, in the conversation its references name. */
  const keep = (session: string, email: Omit<GoogleEmailRecord, "thread">) => {
    const existing = store.emails.find(email.id);
    if (existing) return existing;
    const thread = threadOf(email, (id) => store.byMessageId(id)?.thread) ?? email.id;
    if (thread === email.id) {
      store.threads.add(email.id, { id: email.id, subject: email.subject, createdAt: email.createdAt }, session);
    }
    return store.emails.add(email.id, { ...email, thread }, session);
  };

  /** A message read back from Gmail, as the mirror keeps it. */
  const fromWire = (wire: WireMessage): Omit<GoogleEmailRecord, "thread"> => {
    const headers = wire.payload?.headers ?? [];
    const header = (name: string) => headers.find((each) => each.name.toLowerCase() === name)?.value;
    const [from] = parseAddresses(header("from") ? [header("from") as string] : undefined);
    const sender = from ?? { address: "", name: "" };
    return {
      id: wire.id,
      author: sender.address === store.app.address ? store.app.id : store.personAt(sender.address)?.id,
      from: sender,
      to: parseAddresses(header("to") ? [header("to") as string] : undefined),
      cc: parseAddresses(header("cc") ? [header("cc") as string] : undefined),
      bcc: [],
      replyTo: parseAddresses(header("reply-to") ? [header("reply-to") as string] : undefined),
      subject: header("subject") ?? "",
      text: partText(wire.payload, "text/plain"),
      html: partText(wire.payload, "text/html"),
      messageId: messageIdsIn(header("message-id"))[0] ?? "",
      inReplyTo: messageIdsIn(header("in-reply-to"))[0],
      references: messageIdsIn(header("references")),
      createdAt: Number(wire.internalDate) || clock(),
      raw: undefined,
      headers: headers.map(({ name, value }) => ({ name, value })),
      agentCopy: undefined,
      delivery: undefined,
    };
  };

  let readying: Promise<void> | undefined;
  const prepare = async () => {
    app = live.vault.fromEnv("CHANNELSTACK_GOOGLE_REFRESH_TOKEN");
    if (!app) {
      throw liveMisconfigured("CHANNELSTACK_GOOGLE_REFRESH_TOKEN isn't set", "set the agent's mailbox's refresh token");
    }
    const address = checkGoogleCredential(await identifyGoogle(client, app), {
      who: "CHANNELSTACK_GOOGLE_REFRESH_TOKEN",
      allowlist: live.allowlist,
    });
    store.seed({ id: address, name: deps.appName, address }, "0");
  };

  /** A person sends an email from their own account, answering one when `headers` say so. */
  const sendAs = async (
    session: string,
    person: GoogleUserRecord,
    input: EmailMessageInput,
    headers: { inReplyTo?: string; references?: readonly string[]; thread?: string },
  ): Promise<GoogleEmailRecord> => {
    allowed([...input.to, ...input.cc]);
    const credential = people.actingAs(session, person.id, () => fakeActorInLiveWorld(person.name, "google"));
    const message = {
      from: { address: person.address, name: person.name },
      to: input.to,
      cc: input.cc,
      bcc: [],
      replyTo: [],
      subject: input.subject,
      text: input.text,
      html: input.html,
      messageId: messageId(`channelstack-${randomUUID()}`, domainOf(person.address)),
      inReplyTo: headers.inReplyTo,
      references: headers.references ?? [],
    };
    // What the run sent, for anyone who reads the mail later.
    const raw = await composeMime(message, clock(), { "X-Channelstack-Run": live.tag });
    const sent = await client.call<{ id: string; threadId: string }>(
      credential,
      "POST",
      "gmail/v1/users/me/messages/send",
      {
        raw: Buffer.from(raw).toString("base64url"),
        ...(headers.thread ? { threadId: headers.thread } : {}),
      },
    );
    // The `Message-ID` Gmail kept, which the agent's answer names in `In-Reply-To`.
    const copy = await client.call<WireMessage>(
      credential,
      "GET",
      `gmail/v1/users/me/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`,
    );
    const kept = messageIdsIn(
      copy.payload?.headers?.find((each) => each.name.toLowerCase() === "message-id")?.value,
    )[0];
    await tag(session, credential, person.address, sent.threadId, input.subject);
    gmailThread.set(sent.id, sent.threadId);
    const email = keep(session, {
      ...fromWire(copy),
      ...message,
      id: sent.id,
      author: person.id,
      messageId: kept ?? message.messageId,
      raw,
      headers: [],
      createdAt: clock(),
    });
    if (input.to.some((to) => to.address === store.app.address)) untagged.set(email.messageId, session);
    return email;
  };

  const world = {
    store,

    /** The check before the first live action, run once: its outcome, a failure too, is kept. */
    ready: () => (readying ??= prepare()),

    async createUser(
      session: string,
      input: { name: string; address?: string | undefined; token?: string | undefined },
    ) {
      if (!input.token) {
        if (live.strict) throw fakeActorInLiveWorld(input.name, "google");
        throw liveMisconfigured(
          `${input.name} has no Gmail refresh token`,
          `give them their own account's (CHANNELSTACK_GOOGLE_USER_${input.name.toUpperCase()}_TOKEN)`,
        );
      }
      const credential = live.vault.person(input.name, input.token);
      const address = checkGoogleCredential(await identifyGoogle(client, credential), {
        who: input.name,
        allowlist: live.allowlist,
      });
      if (input.address !== undefined && input.address.toLowerCase() !== address) {
        throw new ProtocolError(
          "invalid_argument",
          `${input.name}'s token is for another address than ${input.address}`,
        );
      }
      if (address === store.app.address)
        throw new ProtocolError("invalid_argument", `${address} is the agent's address`);
      if (!since.has(session)) since.set(session, clock() - CLOCK_SKEW_MS);
      people.join(session, address, input.name || localPartOf(address), credential);
      return store.users.add(address, { id: address, name: input.name, address, fixedId: false }, session);
    },

    send: (session: string, person: GoogleUserRecord, input: EmailMessageInput) => sendAs(session, person, input, {}),

    reply(
      session: string,
      person: GoogleUserRecord,
      to: GoogleEmailRecord,
      input: { text: string | undefined; html: string | undefined; all: boolean },
    ) {
      const { inReplyTo, references, ...message } = replyOf(person, to, input.all);
      const thread = gmailThread.get(to.id);
      return sendAs(
        session,
        person,
        { ...message, text: input.text, html: input.html },
        {
          inReplyTo,
          references,
          ...(thread ? { thread } : {}),
        },
      );
    },

    async inbox(session: string, person: GoogleUserRecord) {
      await world.refresh(session);
      return store.mailTo(person.address);
    },

    /** Read the agent's answers back from each person's mail, and label what the run left in the agent's mailbox. */
    async refresh(session: string) {
      if (clock() - (read.get(session) ?? 0) < READ_CACHE_MS) return;
      read.set(session, clock());
      const after = Math.floor((since.get(session) ?? clock()) / 1000);
      for (const { id: address, credential } of people.of(session)) {
        const query = encodeURIComponent(`from:${store.app.address} after:${after}`);
        const list = await client.call<{ messages?: Array<{ id: string; threadId: string }> }>(
          credential,
          "GET",
          `gmail/v1/users/me/messages?q=${query}&maxResults=100`,
        );
        for (const { id, threadId } of list.messages ?? []) {
          if (store.emails.find(id)) continue;
          const wire = await client.call<WireMessage>(
            credential,
            "GET",
            `gmail/v1/users/me/messages/${id}?format=full`,
          );
          gmailThread.set(id, threadId);
          const email = keep(session, fromWire(wire));
          await tag(session, credential, address, threadId, email.subject);
        }
      }
      // The people's emails, as they reached the agent's mailbox: labelled too, for the sweep.
      for (const [sent, owner] of untagged) {
        if (owner !== session || !app) continue;
        const query = encodeURIComponent(`rfc822msgid:${sent.slice(1, -1)}`);
        const found = await client.call<{ messages?: Array<{ threadId: string }> }>(
          app,
          "GET",
          `gmail/v1/users/me/messages?q=${query}&includeSpamTrash=true`,
        );
        const [copy] = found.messages ?? [];
        if (!copy) continue;
        untagged.delete(sent);
        await tag(session, app, store.app.address, copy.threadId, store.byMessageId(sent)?.subject ?? "");
      }
    },

    /** Live, the agent's labels aren't the test's to read. */
    labelsOf: () => [],

    principalOf: (email: GoogleEmailRecord) => emailAuthor(email, store.app, (id) => store.users.find(id)),

    /** Whose credential removes a ledger entry: the agent's (`app`), or a person's of the session. */
    credential: (owner: string, session: string) => (owner === "app" ? app : people.byOwner(session, owner)),

    release(session: string) {
      people.leave(session);
      read.delete(session);
      since.delete(session);
      for (const [sent, owner] of untagged) if (owner === session) untagged.delete(sent);
      store.users.release(session);
      store.emails.release(session);
      store.threads.release(session);
    },
  };
  return world;
}
