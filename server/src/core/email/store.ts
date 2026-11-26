import { ProtocolError } from "../errors/index.ts";
import type { Collection, Registry } from "../registry/index.ts";
import { localPartOf, type Mailbox, parseAddresses } from "./index.ts";

/**
 * What every email channel keeps (Resend, Gmail): the agent's mailbox, people's mailboxes, every
 * email sent, and the conversations email makes. A channel's store adds its platform's own records.
 */

/** The agent's mailbox: where people email it. */
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
  /** Who wrote it: a person's or the app's id, or none for an address no one in the world has. */
  readonly author: string | undefined;
  readonly from: Mailbox;
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  readonly bcc: readonly Mailbox[];
  readonly replyTo: readonly Mailbox[];
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly messageId: string;
  readonly inReplyTo: string | undefined;
  readonly references: readonly string[];
  /** The conversation it is in, as a test reads it: the id of its first email. */
  readonly thread: string;
  readonly createdAt: number;
  /** For an email to the agent: the delivery that told it. */
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
  #app: App | undefined;

  constructor(registry: Registry, driver: string) {
    this.users = registry.collection(driver, "user");
    this.emails = registry.collection(driver, "email");
    this.threads = registry.collection(driver, "thread");
  }

  /** The agent's mailbox. It belongs to no session. */
  get app(): App {
    if (!this.#app) throw new Error("The fake hasn't been seeded");
    return this.#app;
  }

  protected setApp(app: App): void {
    this.#app = app;
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
    return this.emails.add(email.id, email, session);
  }

  /** A person in the fake: a mailbox at `<name>@example.com` unless the test gives an address. */
  addPerson(session: string, input: { name: string; address?: string | undefined }): EmailPersonRecord {
    let address = input.address?.toLowerCase();
    if (address !== undefined) {
      if (parseAddresses(address)[0]?.address !== address) {
        throw new ProtocolError("invalid_argument", `"${input.address}" is not an email address`);
      }
      if (this.personAt(address) || address === this.app.address) {
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
