import { AppRoster } from "../apps/index.ts";
import { ProtocolError } from "../errors/index.ts";
import type { DriverLoops } from "../loops/index.ts";
import type { Collection, Registry } from "../registry/index.ts";
import { type EmailAttachment, localPartOf, type Mailbox, parseAddresses, threadOf } from "./index.ts";

/**
 * What every email channel keeps (Resend, Gmail): the agent's mailbox, people's mailboxes, every
 * email sent, and the conversations email makes. A channel's store adds its platform's own records.
 */

/** An app's mailbox (the agent's, `my-agent`, or one a test made): where people and other apps email it. */
export interface EmailAppRecord {
  readonly id: string;
  readonly name: string;
  readonly address: string;
}

/** A person: a mailbox in the outside world. Their id is their address. */
export interface EmailPersonRecord {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  /** The test chose the id: freed again when its session closes (decision 0006). */
  readonly fixedId: boolean;
}

/** One email as it was sent, whoever sent it. */
export interface EmailRecord {
  readonly id: string;
  /** Who wrote it: a person's or an app's id, or none for an address no one in the world has. */
  readonly author: string | undefined;
  readonly from: Mailbox;
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  readonly bcc: readonly Mailbox[];
  readonly replyTo: readonly Mailbox[];
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly attachments: readonly EmailAttachment[];
  readonly messageId: string;
  readonly inReplyTo: string | undefined;
  readonly references: readonly string[];
  /** The conversation it is in, as a test reads it: the id of its first email. */
  readonly thread: string;
  readonly createdAt: number;
  /** For an email to the agent: the delivery that told it (the built-in app's; another app's is asked for by app). */
  delivery: string | undefined;
}

/** A conversation: emails joined by `In-Reply-To` and `References`. Its id is its first email's. */
export interface EmailThreadRecord {
  readonly id: string;
  readonly subject: string;
  readonly createdAt: number;
}

/** An email channel's in-memory state. Objects live in the core registry; the store adds the lookups. */
export class EmailStore<Email extends EmailRecord, App extends EmailAppRecord> {
  readonly users: Collection<EmailPersonRecord>;
  readonly emails: Collection<Email>;
  readonly threads: Collection<EmailThreadRecord>;
  /** The agent's mailbox and the ones tests made (decision 0027): each an app with an address of its own. */
  readonly apps: AppRoster<App>;

  /** The loop guard, which the driver hands over from its context. */
  loops: DriverLoops | undefined;
  /** The emails the loop guard stopped: kept, and delivered to nobody. */
  readonly #halted = new WeakSet<Email>();

  constructor(registry: Registry, driver: string, title: string = driver) {
    this.users = registry.collection(driver, "user");
    this.emails = registry.collection(driver, "email");
    this.threads = registry.collection(driver, "thread");
    this.apps = new AppRoster<App>(title, registry, { refs: (app) => [app.id] });
  }

  /** The agent's mailbox: the built-in app, `my-agent`. It belongs to no session. */
  get app(): App {
    return this.apps.builtIn;
  }

  protected setApp(app: App): void {
    this.apps.seed(app);
  }

  /** The app with this address, if one has it. */
  appAt(address: string): App | undefined {
    const wanted = address.toLowerCase();
    return this.apps.all().find((app) => app.address === wanted);
  }

  /** The app with this id, or this name. */
  appOf(handle: string): App | undefined {
    return this.apps.find(handle);
  }

  /** The apps among these mailboxes, each once, in the order the channel's apps are. */
  appsAmong(mailboxes: readonly Mailbox[]): App[] {
    return this.apps.all().filter((app) => mailboxes.some((mailbox) => mailbox.address === app.address));
  }

  /**
   * Make the app named `name` (`createApp`), or return the one made with these settings. Its name
   * can't be a person's of the session asking, nor its address anyone's.
   */
  makeApp(session: string | undefined, name: string, settings: Record<string, unknown>, build: () => App): App {
    const by =
      session === undefined ? undefined : { session, people: this.users.list(session).map((user) => user.name) };
    return this.apps.make(
      name,
      settings,
      () => {
        const app = build();
        if (this.personAt(app.address) || this.appAt(app.address)) {
          throw new ProtocolError("invalid_argument", `Someone has the address ${app.address} already`, { app: name });
        }
        return app;
      },
      by,
    );
  }

  /**
   * Which conversation an app's email joins (the one it answers by `In-Reply-To` and `References`),
   * and whose session it is in: that conversation's, or else the session of a person it reaches,
   * or else, for a new email between apps alone, the session of the apps it is between.
   */
  placeOf(
    message: { readonly inReplyTo?: string | undefined; readonly references: readonly string[] },
    recipients: readonly Mailbox[],
    sender: App,
  ): { thread: string | undefined; session: string | undefined } {
    const thread = threadOf(message, (id) => this.byMessageId(id)?.thread);
    if (thread !== undefined) return { thread, session: this.threads.owner(thread) };
    const reached = recipients.map((mailbox) => this.personAt(mailbox.address)).find(Boolean);
    if (reached !== undefined) return { thread, session: this.users.owner(reached.id) };
    return { thread, session: this.#sessionBetween(sender, this.appsAmong(recipients)) };
  }

  /**
   * The session an email between apps alone is in (decision 0027): one that used each app made
   * with `createApp` among them. Where several did, the one the sender last wrote or was written
   * to in, else the last to use them. None when no open session used them.
   */
  #sessionBetween(sender: App, recipients: readonly App[]): string | undefined {
    const made = [sender, ...recipients].filter((app) => app !== this.app);
    if (made.length === 0) return undefined;
    const [first, ...rest] = made.map((app) => this.apps.sessionsOf(app));
    const shared = (first ?? []).filter((session) => rest.every((sessions) => sessions.includes(session)));
    const latest = this.emails
      .values()
      .filter(
        (email) =>
          email.author === sender.id ||
          [...email.to, ...email.cc, ...email.bcc].some((mailbox) => mailbox.address === sender.address),
      )
      .map((email) => this.emails.owner(email.id))
      .findLast((session) => session !== undefined && shared.includes(session));
    return latest ?? shared.at(-1);
  }

  /** The person with this address, in any session. */
  personAt(address: string): EmailPersonRecord | undefined {
    const wanted = address.toLowerCase();
    return this.users.values().find((user) => user.address === wanted);
  }

  /** The email with this `Message-ID`, in any session. */
  byMessageId(messageId: string): Email | undefined {
    return this.emails.values().find((email) => email.messageId === messageId);
  }

  /** A conversation's emails, oldest first. */
  emailsIn(thread: string): Email[] {
    return this.emails
      .values()
      .filter((email) => email.thread === thread)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** What reached an address: every email it is a recipient of, oldest first. */
  mailTo(address: string): Email[] {
    return this.emails
      .values()
      .filter((email) => [...email.to, ...email.cc, ...email.bcc].some((mailbox) => mailbox.address === address))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Keep an email, and the conversation it starts. */
  keep(email: Email, session: string | undefined): Email {
    if (email.thread === email.id) {
      this.threads.add(email.id, { id: email.id, subject: email.subject, createdAt: email.createdAt }, session);
    }
    // The loop guard counts what apps write in a conversation where no person writes in between (decision 0027).
    const app = email.author === undefined ? undefined : this.apps.byId(email.author);
    const writer = app ? { kind: "app" as const, name: app.name } : { kind: "person" as const };
    if (session !== undefined && this.loops?.wrote(session, email.thread, writer) === false) this.#halted.add(email);
    return this.emails.add(email.id, email, session);
  }

  /** The loop guard stopped this app email's conversation: it is kept, and nothing is delivered for it. */
  halted(email: Email): boolean {
    return this.#halted.has(email);
  }

  /**
   * Keep an email a live world read back or sent, once (by its id), in the conversation its
   * `In-Reply-To` and `References` name, or one of its own.
   */
  mirror(email: Omit<Email, "thread">, session: string): Email {
    const existing = this.emails.find(email.id);
    if (existing) return existing;
    const thread = threadOf(email, (id) => this.byMessageId(id)?.thread) ?? email.id;
    return this.keep({ ...email, thread } as Email, session);
  }

  /** A person in the fake: a mailbox at `<name>@example.com` unless the test gives an address. */
  addPerson(session: string, input: { name: string; address?: string | undefined }): EmailPersonRecord {
    // A name in a matcher means one author: a person can't take the name of an app their session used.
    this.apps.checkPerson(session, input.name);
    let address = input.address?.toLowerCase();
    if (address !== undefined) {
      if (parseAddresses(address)[0]?.address !== address) {
        throw new ProtocolError("invalid_argument", `"${input.address}" is not an email address`);
      }
      if (this.personAt(address) || this.appAt(address)) {
        throw new ProtocolError("invalid_argument", `Someone has the address ${address} already`);
      }
    } else {
      const local = localPartOf(input.name);
      address = `${local}@example.com`;
      for (let n = 2; this.personAt(address); n++) address = `${local}${n}@example.com`;
    }
    return this.users.add(address, { id: address, name: input.name, address, fixedId: false }, session);
  }
}
