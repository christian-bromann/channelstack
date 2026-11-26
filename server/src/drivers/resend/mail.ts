import { type Mailbox, replyHeaders, replySubject } from "../../core/email/index.ts";
import type { TranscriptPrincipal } from "../../core/router/inspect.ts";
import type { ResendStore } from "./fake/store.ts";
import type { ResendEmailRecord, ResendUserRecord } from "./world.ts";

/** Who wrote an email, as a transcript names them: the app, a person, or the address itself. */
export function principalOf(store: ResendStore, email: ResendEmailRecord): TranscriptPrincipal {
  if (email.author === store.app.id) return { id: store.app.id, name: store.app.name, kind: "app" };
  const person = email.author === undefined ? undefined : store.users.find(email.author);
  if (person) return { id: person.id, name: person.name, kind: "user" };
  return { id: email.from.address, name: email.from.name || email.from.address, kind: "user" };
}

/**
 * A person's reply to an email: to its sender (its `Reply-To` if it has one), and with `all` to
 * everyone else on it too; `Re:` its subject, `In-Reply-To` and `References` set.
 */
export function replyOf(person: ResendUserRecord, to: ResendEmailRecord, all: boolean) {
  const sender: readonly Mailbox[] = to.replyTo.length > 0 ? to.replyTo : [to.from];
  const others = all
    ? [...to.to, ...to.cc].filter(
        (mailbox) => mailbox.address !== person.address && !sender.some((s) => s.address === mailbox.address),
      )
    : [];
  return {
    to: sender,
    cc: others,
    subject: replySubject(to.subject),
    ...replyHeaders({ messageId: to.messageId, references: to.references }),
  };
}
