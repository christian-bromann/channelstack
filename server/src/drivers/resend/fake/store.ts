import type { Collection, Registry } from "../../../core/registry/index.ts";
import type { ResendAppRecord, ResendEmailRecord, ResendThreadRecord, ResendUserRecord } from "../world.ts";

/** The Resend fake's in-memory state. Objects live in the core registry; the store adds Resend's lookups. */
export class ResendStore {
  readonly users: Collection<ResendUserRecord>;
  readonly emails: Collection<ResendEmailRecord>;
  readonly threads: Collection<ResendThreadRecord>;
  #app: ResendAppRecord | undefined;

  constructor(registry: Registry) {
    this.users = registry.collection("resend", "user");
    this.emails = registry.collection("resend", "email");
    this.threads = registry.collection("resend", "thread");
  }

  /** The agent's team. It belongs to no session. */
  get app(): ResendAppRecord {
    if (!this.#app) throw new Error("The Resend fake hasn't been seeded");
    return this.#app;
  }

  seed(app: ResendAppRecord): void {
    this.#app = app;
  }

  /** The person with this address, in any session. */
  personAt(address: string): ResendUserRecord | undefined {
    const wanted = address.toLowerCase();
    return this.users.values().find((user) => user.address === wanted);
  }

  /** The email with this `Message-ID`, in any session. */
  byMessageId(messageId: string): ResendEmailRecord | undefined {
    return this.emails.values().find((email) => email.messageId === messageId);
  }

  /** A thread's emails, oldest first. */
  emailsIn(thread: string): ResendEmailRecord[] {
    return this.emails
      .values()
      .filter((email) => email.thread === thread)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** What reached an address: every email it is a recipient of, oldest first. */
  mailTo(address: string): ResendEmailRecord[] {
    return this.emails
      .values()
      .filter((email) => [...email.to, ...email.cc, ...email.bcc].some((mailbox) => mailbox.address === address))
      .sort((a, b) => a.createdAt - b.createdAt);
  }
}
