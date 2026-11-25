import type { Clock } from "../../../core/clock/index.ts";
import {
  domainOf,
  formatMailbox,
  type Mailbox,
  messageIdsIn,
  parseAddresses,
  threadOf,
} from "../../../core/email/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import { LivePeople } from "../../../core/people/index.ts";
import { fakeActorInLiveWorld, liveMisconfigured } from "../../../core/reality/index.ts";
import { Registry } from "../../../core/registry/index.ts";
import type { LiveContext } from "../../../core/router/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { ResendMessageInput, ResendWorld } from "../backend.ts";
import { ResendStore } from "../fake/store.ts";
import { principalOf, replyOf } from "../mail.ts";
import type { ResendEmailRecord, ResendUserRecord } from "../world.ts";
import type { ResendRestClient } from "./client.ts";
import { checkResendCredential, identifyResend } from "./identity.ts";

/** Reading the people's mail again more often than this is a waste: the agent takes seconds to answer. */
const READ_CACHE_MS = 1_000;

interface WireReceived {
  id: string;
  from: string;
  to: string[];
  cc?: string[] | null;
  reply_to?: string[] | null;
  subject: string;
  message_id: string;
  created_at: string;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string> | null;
}

/**
 * The live Resend world: the agent's team is a real one, and each person is a team of their own
 * (an API key, an address on its verified domain). A person's email goes out through Resend, from
 * their team; the agent's answers are read back from each person's received mail. channelstack
 * never delivers to the agent: Resend does.
 */
export function createLiveResendWorld(deps: {
  client: ResendRestClient;
  live: LiveContext;
  clock: Clock;
  appName: string;
}): ResendWorld & { ready(): Promise<void>; release(session: string): void } {
  const { client, live, clock } = deps;
  const store = new ResendStore(new Registry());
  const people = new LivePeople();
  const read = new Map<string, number>();
  /**
   * What people sent whose `Message-ID` Resend hadn't given yet: it assigns one once the email is
   * on its way, and an answer names it in `In-Reply-To`. By the email's id, with whose key sent it.
   */
  const unnamed = new Map<string, LiveCredential>();
  let app: LiveCredential | undefined;

  /** Everyone an email goes to must be at an allowlisted domain (or a Resend test address): sent mail can't be taken back. */
  const allowed = (mailboxes: readonly Mailbox[]) => {
    for (const { address } of mailboxes) {
      if (domainOf(address) !== "resend.dev") live.allowlist.assert(domainOf(address), `the address ${address}`);
    }
  };

  /** Keep what was read or sent in the mirror, in the thread its references name. */
  const keep = (session: string, email: Omit<ResendEmailRecord, "thread">) => {
    const existing = store.emails.find(email.id);
    if (existing) return existing;
    const thread = threadOf(email, (id) => store.byMessageId(id)?.thread) ?? email.id;
    if (thread === email.id)
      store.threads.add(email.id, { id: email.id, subject: email.subject, createdAt: email.createdAt }, session);
    return store.emails.add(email.id, { ...email, thread }, session);
  };

  let readying: Promise<void> | undefined;
  const prepare = async () => {
    app = live.vault.fromEnv("CHANNELSTACK_RESEND_API_KEY");
    if (!app) throw liveMisconfigured("CHANNELSTACK_RESEND_API_KEY isn't set", "set the agent's team's API key");
    const address = live.vault.setting("CHANNELSTACK_RESEND_ADDRESS")?.toLowerCase();
    const identity = await identifyResend(client, app);
    const domain = checkResendCredential(identity, {
      who: "CHANNELSTACK_RESEND_API_KEY",
      allowlist: live.allowlist,
      address,
    });
    const team = identity.domains.find((each) => each.name === domain);
    store.seed({
      id: team?.id ?? domain,
      name: deps.appName,
      address: address ?? `${deps.appName}@${domain}`,
      domain,
      domainId: team?.id ?? domain,
      webhookId: "",
      events: [],
    });
  };

  /** A person sends an email through their own team, answering one when `headers` say so. */
  const sendAs = async (
    session: string,
    person: ResendUserRecord,
    input: ResendMessageInput,
    headers: { inReplyTo?: string; references?: readonly string[] },
  ): Promise<ResendEmailRecord> => {
    allowed([...input.to, ...input.cc]);
    const credential = people.actingAs(session, person.id, () => fakeActorInLiveWorld(person.name, "resend"));
    const { id } = await client.call<{ id: string }>(credential, "POST", "/emails", {
      from: formatMailbox({ address: person.address, name: person.name }),
      to: input.to.map((mailbox) => mailbox.address),
      cc: input.cc.map((mailbox) => mailbox.address),
      subject: input.subject,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.html === undefined ? {} : { html: input.html }),
      headers: {
        // What the run sent, for anyone who reads the mail later.
        "X-Channelstack-Run": live.tag,
        ...(headers.inReplyTo ? { "In-Reply-To": headers.inReplyTo } : {}),
        ...(headers.references && headers.references.length > 0 ? { References: headers.references.join(" ") } : {}),
      },
    });
    // Its `Message-ID`, which the agent's answer will name in `In-Reply-To`.
    const sent = await client.call<{ message_id?: string | null }>(credential, "GET", `/emails/${id}`);
    if (!sent.message_id) unnamed.set(id, credential);
    return keep(session, {
      id,
      direction: "outside",
      author: person.id,
      from: { address: person.address, name: person.name },
      to: input.to,
      cc: input.cc,
      bcc: [],
      replyTo: [],
      subject: input.subject,
      text: input.text,
      html: input.html,
      headers: {},
      tags: {},
      messageId: sent.message_id ?? `<${id}@resend.dev>`,
      inReplyTo: headers.inReplyTo,
      references: headers.references ?? [],
      createdAt: clock(),
      lastEvent: undefined,
      delivery: undefined,
    });
  };

  const world: ResendWorld & { ready(): Promise<void>; release(session: string): void } = {
    store,

    /** The check before the first live action, run once: its outcome, a failure too, is kept. */
    ready: () => (readying ??= prepare()),

    async createUser(session, input) {
      if (!input.token) {
        if (live.strict) throw fakeActorInLiveWorld(input.name, "resend");
        throw liveMisconfigured(
          `${input.name} has no Resend key`,
          `give them their own team's key (CHANNELSTACK_RESEND_USER_${input.name.toUpperCase()}_TOKEN)`,
        );
      }
      const credential = live.vault.person(input.name, input.token);
      const identity = await identifyResend(client, credential);
      const domain = checkResendCredential(identity, {
        who: input.name,
        allowlist: live.allowlist,
        address: input.address,
      });
      const local =
        input.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ".")
          .replace(/^\.|\.$/g, "") || "person";
      const address = input.address?.toLowerCase() ?? `${local}@${domain}`;
      if (address === store.app.address) {
        throw new ProtocolError("invalid_argument", `${address} is the agent's address`);
      }
      people.join(session, address, input.name, credential);
      return store.users.add(address, { id: address, name: input.name, address, fixedId: false }, session);
    },

    send: (session, person, input) => sendAs(session, person, input, {}),

    reply(session, person, to, input) {
      const { inReplyTo, references, ...message } = replyOf(person, to, input.all);
      return sendAs(session, person, { ...message, text: input.text, html: input.html }, { inReplyTo, references });
    },

    async inbox(session, person) {
      await world.refresh(session);
      return store.mailTo(person.address);
    },

    /** Read each person's received mail back from their own team: the agent's answers among it. */
    async refresh(session) {
      if (clock() - (read.get(session) ?? 0) < READ_CACHE_MS) return;
      read.set(session, clock());
      // First the `Message-ID`s Resend has given since: the answers are threaded by them.
      for (const [id, credential] of unnamed) {
        const record = store.emails.find(id);
        if (store.emails.owner(id) !== session || !record) continue;
        const sent = await client.call<{ message_id?: string | null }>(credential, "GET", `/emails/${id}`);
        if (!sent.message_id) continue;
        unnamed.delete(id);
        store.emails.add(id, { ...record, messageId: sent.message_id }, session);
      }
      for (const { id: address, credential } of people.of(session)) {
        const list = await client.call<{ data: Array<{ id: string }> }>(
          credential,
          "GET",
          `/emails/receiving?to=${encodeURIComponent(address)}&limit=100`,
        );
        for (const { id } of list.data) {
          if (store.emails.find(id)) continue;
          const email = await client.call<WireReceived>(credential, "GET", `/emails/receiving/${id}`);
          const [from] = parseAddresses(email.from);
          if (!from) continue;
          const header = (name: string) => email.headers?.[name] ?? email.headers?.[name.toLowerCase()];
          keep(session, {
            id,
            direction: "outside",
            author: from.address === store.app.address ? store.app.id : store.personAt(from.address)?.id,
            from,
            to: parseAddresses(email.to),
            cc: parseAddresses(email.cc ?? []),
            bcc: [],
            replyTo: parseAddresses(email.reply_to ?? []),
            subject: email.subject,
            text: email.text ?? undefined,
            html: email.html ?? undefined,
            headers: {},
            tags: {},
            messageId: email.message_id,
            inReplyTo: messageIdsIn(header("In-Reply-To"))[0],
            references: messageIdsIn(header("References")),
            createdAt: Date.parse(email.created_at) || clock(),
            lastEvent: undefined,
            delivery: undefined,
          });
        }
      }
    },

    principalOf: (email) => principalOf(store, email),

    release(session) {
      people.leave(session);
      read.delete(session);
      store.users.release(session);
      store.emails.release(session);
      store.threads.release(session);
    },
  };
  return world;
}
