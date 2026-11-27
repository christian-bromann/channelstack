import type { DevAdapter } from "../dev/index.ts";

const segment = encodeURIComponent;

/**
 * An email channel in the dev tools: a place is a thread, by its subject, started by a person's
 * email to the agent. Saying something in a thread answers its newest email; `title` is the
 * channel's type prefix (`Resend`).
 */
export function emailDev(title: string): DevAdapter {
  return {
    place: "thread",
    example: '"Refund for order 1234"',
    resource: `${title}Thread`,
    listing: { path: "/threads", id: "{id}", name: ["{subject}"], transcript: "/threads/{id}/transcript" },
    personBody: (name) => ({ name }),
    async create({ api, person, app, name, text }) {
      const email = await api.post<{ thread: Record<string, unknown> }>(`/users/${segment(person.id)}/send`, {
        to: [app.id],
        subject: name,
        text: text ?? "",
      });
      return email.thread;
    },
    async say({ api, place, person, text }) {
      const { entries } = await api.get<{ entries: Array<{ id: string }> }>(place.transcript);
      await api.post(`/users/${segment(person.id)}/reply`, { email: entries.at(-1)?.id, text, all: true });
    },
    async reply({ api, target, person, text }) {
      await api.post(`/users/${segment(person.id)}/reply`, { email: target.entries[target.index]?.id, text });
    },
    async refs(_api, target) {
      return { [`${title}Thread`]: target.place.id, [`${title}Email`]: target.entries[target.index]?.id };
    },
  };
}
