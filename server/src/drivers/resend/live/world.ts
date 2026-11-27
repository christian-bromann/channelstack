import type { Clock } from "../../../core/clock/index.ts";
import {
  domainOf,
  emailAuthor,
  formatMailbox,
  localPartOf,
  type Mailbox,
  messageIdsIn,
  parseAddresses,
  replyOf,
} from "../../../core/email/index.ts";
import type { EmailMessageInput } from "../../../core/email/routes.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import { LivePeople } from "../../../core/people/index.ts";
import { checkOnce, fakeActorInLiveWorld, liveMisconfigured } from "../../../core/reality/index.ts";
import { Registry } from "../../../core/registry/index.ts";
import type { LiveContext } from "../../../core/router/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { ResendWorld } from "../backend.ts";
import { ResendStore } from "../fake/store.ts";
import type { ResendEmailRecord, ResendUserRecord } from "../world.ts";
import type { ResendRestClient } from "./client.ts";
import { checkResendCredential, identifyResend } from "./identity.ts";

/** Reading the people's mail again more often than this is a waste: the agent takes seconds to answer. */
const READ_CACHE_MS = 1_000;
/** How far Resend's clock may be from ours. */
const CLOCK_SKEW_MS = 5_000;

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
  attachments?: Array<{
    id: string;
    filename?: string | null;
    content_type?: string;
    content_id?: string;
    size?: number;
  }>;
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
   * When each session's first person joined: older mail in their inboxes is an earlier run's, so it
   * is neither read again nor shown. A few seconds early, for the clocks' difference with Resend's.
   */
  const since = new Map<string, number>();
  /**
   * What people sent whose `Message-ID` Resend hadn't given yet: it assigns one once the email is
   * on its way, and an answer names it in `In-Reply-To`. By the email's id, with whose key sent it.
   */
  const unnamed = new Map<string, LiveCredential>();
  /**
   * A sent email's `Message-ID`, or undefined while Resend hasn't one to give: right after a send
   * it answers `not_found` for the email, then an email without one, as found against Resend.
   */
  const messageIdOf = async (credential: LiveCredential, id: string): Promise<string | undefined> => {
    try {
      const sent = await client.call<{ message_id?: string | null }>(credential, "GET", `/emails/${id}`);
      return sent.message_id ?? undefined;
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "not_found") return undefined;
      throw error;
    }
  };
  let app: LiveCredential | undefined;

  /**
   * Everyone an email goes to must be at an allowlisted domain (or a Resend test address): sent mail
   * can't be taken back. The people and the agent were checked when they joined; what this catches is
   * an address the agent's answer named (its `Reply-To`, or a `Cc` a reply to all goes to).
   */
  const allowed = (mailboxes: readonly Mailbox[]) => {
    for (const { address } of mailboxes) {
      if (domainOf(address) !== "resend.dev") live.allowlist.assert(domainOf(address), `the address ${address}`);
    }
  };

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
    input: EmailMessageInput,
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
    const messageId = await messageIdOf(credential, id);
    if (messageId === undefined) unnamed.set(id, credential);
    return store.mirror(
      {
        id,
        direction: "outside",
        team: undefined,
        author: person.id,
        from: { address: person.address, name: person.name },
        to: input.to,
        cc: input.cc,
        bcc: [],
        replyTo: [],
        subject: input.subject,
        text: input.text,
        html: input.html,
        attachments: [],
        headers: {},
        tags: {},
        raw: undefined,
        messageId: messageId ?? `<${id}@resend.dev>`,
        inReplyTo: headers.inReplyTo,
        references: headers.references ?? [],
        createdAt: clock(),
        lastEvent: undefined,
        delivery: undefined,
      },
      session,
    );
  };

  const world: ResendWorld & { ready(): Promise<void>; release(session: string): void } = {
    store,

    /** The check before the first live action: a definitive answer is kept, a network error, 5xx or 429 is asked again (`checkOnce`). */
    ready: checkOnce(prepare),

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
      const address = input.address?.toLowerCase() ?? `${localPartOf(input.name)}@${domain}`;
      if (address === store.app.address) {
        throw new ProtocolError("invalid_argument", `${address} is the agent's address`);
      }
      if (!since.has(session)) since.set(session, clock() - CLOCK_SKEW_MS);
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
        const messageId = await messageIdOf(credential, id);
        if (messageId === undefined) continue;
        unnamed.delete(id);
        store.emails.add(id, { ...record, messageId }, session);
      }
      for (const { id: address, credential } of people.of(session)) {
        const list = await client.call<{ data: Array<{ id: string; created_at?: string }> }>(
          credential,
          "GET",
          `/emails/receiving?to=${encodeURIComponent(address)}&limit=100`,
        );
        for (const { id, created_at } of list.data) {
          if (store.emails.find(id)) continue;
          if (created_at !== undefined && Date.parse(created_at) < (since.get(session) ?? 0)) continue;
          const email = await client.call<WireReceived>(credential, "GET", `/emails/receiving/${id}`);
          const [from] = parseAddresses(email.from);
          if (!from) continue;
          const header = (name: string) => email.headers?.[name] ?? email.headers?.[name.toLowerCase()];
          store.mirror(
            {
              id,
              direction: "outside",
              team: undefined,
              author: from.address === store.app.address ? store.app.id : store.personAt(from.address)?.id,
              from,
              to: parseAddresses(email.to),
              cc: parseAddresses(email.cc ?? []),
              bcc: [],
              replyTo: parseAddresses(email.reply_to ?? []),
              subject: email.subject,
              text: email.text ?? undefined,
              html: email.html ?? undefined,
              // What a transcript names of them: their content stays at Resend.
              attachments: (email.attachments ?? []).map((attachment, at) => ({
                id: attachment.id,
                filename: attachment.filename ?? `attachment-${at}`,
                contentType: attachment.content_type ?? "application/octet-stream",
                size: attachment.size ?? 0,
                content: undefined,
                contentId: attachment.content_id,
              })),
              headers: {},
              tags: {},
              raw: undefined,
              messageId: email.message_id,
              inReplyTo: messageIdsIn(header("In-Reply-To"))[0],
              references: messageIdsIn(header("References")),
              createdAt: Date.parse(email.created_at) || clock(),
              lastEvent: undefined,
              delivery: undefined,
            },
            session,
          );
        }
      }
    },

    principalOf: (email) => emailAuthor(email, store.apps.all(), (id) => store.users.find(id)),

    release(session) {
      people.leave(session);
      read.delete(session);
      since.delete(session);
      for (const id of unnamed.keys()) if (store.emails.owner(id) === session) unnamed.delete(id);
      store.users.release(session);
      store.emails.release(session);
      store.threads.release(session);
    },
  };
  return world;
}
