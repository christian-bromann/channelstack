import type { Clock } from "../../../core/clock/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import { LivePeople } from "../../../core/people/index.ts";
import { fakeActorInLiveWorld, liveMisconfigured, unsupportedInLive } from "../../../core/reality/index.ts";
import { Registry } from "../../../core/registry/index.ts";
import type { LiveContext } from "../../../core/router/index.ts";
import { LiveCredential } from "../../../core/secrets/index.ts";
import type { TwilioWorld } from "../backend.ts";
import { TwilioStore } from "../fake/store.ts";
import { isTwilioAnswer, optOutTypeOf } from "../sms.ts";
import type { TwilioMessageRecord } from "../world.ts";
import { accountOf, type TwilioRestClient, type WireMessage } from "./client.ts";
import { checkTwilioCredential, identifyTwilio } from "./identity.ts";

/** Reading the people's messages again more often than this is a waste: the agent takes seconds to answer. */
const READ_CACHE_MS = 1_000;
/** How far Twilio's clock may be from ours. */
const CLOCK_SKEW_MS = 5_000;

/**
 * The live Twilio world: the agent's number is a real one on its account, and each person is
 * another number that can send, on an account the person's token opens (the agent's own, or
 * another). A person's text goes out through Twilio from their number; the agent's answers are
 * read back from what reached it. Every message the session saw is on the ledger, and deleted when
 * the session closes: Twilio keeps messages until they are. channelstack never delivers to the
 * agent: Twilio does.
 */
export function createLiveTwilioWorld(deps: {
  client: TwilioRestClient;
  live: LiveContext;
  clock: Clock;
  appName: string;
}): TwilioWorld & {
  ready(): Promise<void>;
  release(session: string): void;
  credential(owner: string, session: string): LiveCredential | undefined;
} {
  const { client, live, clock } = deps;
  const store = new TwilioStore(new Registry());
  const people = new LivePeople();
  const read = new Map<string, number>();
  /** When each session's first person joined: older messages are an earlier run's, so they are neither read nor shown. */
  const since = new Map<string, number>();
  /** The copies on the ledger, by `<session> <account> <from> <to>`: each set once. */
  const ledgered = new Set<string>();
  let app: LiveCredential | undefined;

  /**
   * Put on the ledger, once, every message from one number to another on the account a credential
   * opens, since the session began: each copy of a text is a message of its own on each account,
   * and those that arrive later (the agent's answers, the copy at the recipient's) are found when
   * the ledger deletes them, not by what a read happened to see.
   */
  const ledger = (session: string, credential: LiveCredential, from: string, to: string) => {
    const key = `${session} ${accountOf(credential)} ${from} ${to}`;
    if (ledgered.has(key)) return;
    ledgered.add(key);
    live.ledger.record({
      channel: "twilio",
      kind: "messages",
      ref: { account: accountOf(credential), from, to, since: String(since.get(session) ?? clock()) },
      workspace: to,
      by: credential.owner,
      session,
    });
  };

  /** A message Twilio answered or listed, kept once, in the conversation of its two numbers. */
  const mirror = (session: string, wire: WireMessage): TwilioMessageRecord => {
    const existing = store.messages.find(wire.sid);
    if (existing) {
      existing.status = wire.status;
      existing.errorCode = wire.error_code ?? undefined;
      return existing;
    }
    const at = Date.parse(wire.date_created) || clock();
    const author = wire.from === store.app.number ? store.app.id : store.personAt(wire.from)?.id;
    const message: TwilioMessageRecord = {
      id: wire.sid,
      accountSid: wire.account_sid,
      from: wire.from,
      to: wire.to,
      body: wire.body ?? "",
      media: [],
      segments: Number(wire.num_segments) || 1,
      direction:
        wire.direction === "inbound"
          ? "inbound"
          : wire.direction === "outbound-reply"
            ? "outbound-reply"
            : "outbound-api",
      status: wire.status,
      errorCode: wire.error_code ?? undefined,
      author,
      // Twilio's own answer to `START` or `HELP`, from the agent's number: not the agent's.
      automatic: wire.from === store.app.number && isTwilioAnswer(wire.body ?? ""),
      conversation: store.conversationFor(wire.from, wire.to, wire.sid, at, session),
      messagingServiceSid: undefined,
      statusCallback: undefined,
      createdAt: at,
      sentAt: wire.date_sent === null ? undefined : Date.parse(wire.date_sent),
      updatedAt: clock(),
      delivery: undefined,
    };
    return store.keep(message, session);
  };

  let readying: Promise<void> | undefined;
  const prepare = async () => {
    const sid = live.vault.setting("CHANNELSTACK_TWILIO_ACCOUNT_SID");
    const token = live.vault.fromEnv("CHANNELSTACK_TWILIO_AUTH_TOKEN");
    const number = live.vault.setting("CHANNELSTACK_TWILIO_NUMBER");
    if (!sid || !token || !number) {
      throw liveMisconfigured(
        "CHANNELSTACK_TWILIO_ACCOUNT_SID, CHANNELSTACK_TWILIO_AUTH_TOKEN and CHANNELSTACK_TWILIO_NUMBER aren't all set",
        "set the agent's account and its number",
      );
    }
    app = new LiveCredential("app", `${sid}:${token.reveal()}`);
    const identity = await identifyTwilio(client, app);
    checkTwilioCredential(identity, { who: "the agent", allowlist: live.allowlist, number });
    const { incoming_phone_numbers: [found] = [] } = await client.call<{
      incoming_phone_numbers?: Array<{ sid: string }>;
    }>(app, "GET", `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`);
    store.seed({ id: found?.sid ?? number, name: deps.appName, number, accountSid: sid, messagingServiceSid: "" });
  };

  const world = {
    store,

    /** The check before the first live action, run once: its outcome, a failure too, is kept. */
    ready: () => (readying ??= prepare()),

    async createUser(session: string, input: Parameters<TwilioWorld["createUser"]>[1]) {
      if (input.reachable === false) {
        throw unsupportedInLive("createUser({ reachable: false })", "a real phone can't be switched off from here");
      }
      if (!input.token) {
        if (live.strict) throw fakeActorInLiveWorld(input.name, "twilio");
        throw liveMisconfigured(
          `${input.name} has no Twilio account`,
          `give them the account that owns their number (CHANNELSTACK_TWILIO_USER_${input.name.toUpperCase()}_TOKEN)`,
        );
      }
      if (!/^AC[0-9a-f]{32}:./.test(input.token)) {
        throw new ProtocolError("invalid_argument", `${input.name}'s token isn't \`<Account SID>:<Auth Token>\``);
      }
      const credential = live.vault.person(input.name, input.token);
      const identity = await identifyTwilio(client, credential);
      const number = checkTwilioCredential(identity, {
        who: input.name,
        allowlist: live.allowlist,
        number: input.number,
        besides: store.app.number,
      });
      if (number === store.app.number) throw new ProtocolError("invalid_argument", `${number} is the agent's number`);
      if (!since.has(session)) since.set(session, clock() - CLOCK_SKEW_MS);
      people.join(session, number, input.name, credential);
      return store.users.add(number, { id: number, name: input.name, number, reachable: true }, session);
    },

    /** A person texts from their number, through their account. Every recipient is allowlisted first. */
    async text(
      session: string,
      person: { id: string; name: string; number: string },
      input: { to: string; body: string; media: readonly string[] },
    ) {
      live.allowlist.assert(input.to, `the number ${input.to}`);
      if (optOutTypeOf(input.body) === "STOP") {
        throw unsupportedInLive("texting STOP", "the sandbox number would stay opted out for every later run");
      }
      const credential = people.actingAs(session, person.id, () => fakeActorInLiveWorld(person.name, "twilio"));
      const recipient =
        input.to === store.app.number ? app : people.of(session).find(({ id }) => id === input.to)?.credential;
      const sent = await client.call<WireMessage>(credential, "POST", "/Messages.json", {
        To: input.to,
        From: person.number,
        Body: input.body,
        MediaUrl: input.media,
      });
      // The person's text on their account and at the recipient's; to the agent, its answers on both too.
      ledger(session, credential, person.number, input.to);
      if (recipient) ledger(session, recipient, person.number, input.to);
      if (recipient && input.to === store.app.number) {
        ledger(session, credential, store.app.number, person.number);
        ledger(session, recipient, store.app.number, person.number);
      }
      return mirror(session, sent);
    },

    async inbox(session: string, person: { number: string }) {
      await world.refresh(session);
      return store.messagesTo(person.number);
    },

    /**
     * Read back, for each person of the session, what reached them from the agent: the inbound copy
     * on their own account (with the agent's number on the same account, its outbound copy is
     * listed there too). The ledger has every copy already, by its numbers.
     */
    async refresh(session: string) {
      if (clock() - (read.get(session) ?? 0) < READ_CACHE_MS) return;
      read.set(session, clock());
      const after = since.get(session) ?? clock();
      for (const { id: number, credential } of people.of(session)) {
        for (const wire of await client.messagesBetween(credential, store.app.number, number, after)) {
          if (wire.direction === "inbound") mirror(session, wire);
        }
      }
    },

    /** Whose credential removes a ledger entry: the agent's (`app`), or a person's of the session. */
    credential: (owner: string, session: string) => (owner === "app" ? app : people.byOwner(session, owner)),

    release(session: string) {
      people.leave(session);
      read.delete(session);
      since.delete(session);
      for (const key of ledgered) if (key.startsWith(`${session} `)) ledgered.delete(key);
      store.messages.release(session);
      store.users.release(session);
      store.conversations.release(session);
    },
  };
  return world;
}
