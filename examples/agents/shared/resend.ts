/**
 * What the Resend reference agents do, written once against the `resend` SDK so each agent behaves
 * the same. Scripted, so tests can rely on it: an email to the agent is read back through the
 * receiving API and answered once, in its thread, by the sender's address. An email it sent itself
 * is never answered, and an email Resend sends again (the same `email_id`) is answered only once.
 */
import type { Resend } from "resend";

import { scriptedAnswer } from "./email.ts";

/** The address the agent sends from, as `channelstack env` prints it (`RESEND_FROM`). */
const FROM = process.env.RESEND_FROM ?? "my-agent <my-agent@acme.example>";
const own = (FROM.match(/<([^>]+)>/)?.[1] ?? FROM).toLowerCase();

export function resendAgent(resend: Resend) {
  /** The received emails answered so far: Resend sends a webhook again with the same `email_id`. */
  const answered = new Set<string>();

  async function received(id: string) {
    if (answered.has(id)) return;
    answered.add(id);
    const { data: email, error } = await resend.emails.receiving.get(id);
    if (error || !email) throw new Error(`Couldn't read the received email ${id}: ${error?.message}`);
    const sender = (email.from.match(/<([^>]+)>/)?.[1] ?? email.from).toLowerCase();
    if (sender === own) return;
    const references = [email.headers?.references, email.message_id].filter(Boolean).join(" ");
    const { error: failed } = await resend.emails.send({
      from: FROM,
      to: [sender],
      subject: /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`,
      text: scriptedAnswer(email.subject, email.text ?? ""),
      headers: { "In-Reply-To": email.message_id, References: references },
    });
    if (failed) throw new Error(`Couldn't send the answer: ${failed.message}`);
  }

  return {
    /** Handle one verified webhook event. */
    async handle(event: { type: string; data: { email_id: string } }) {
      if (event.type === "email.received") await received(event.data.email_id);
    },
  };
}
