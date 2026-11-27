import type { DevAdapter, DevApi, DevTarget } from "../../core/dev/index.ts";

const segment = encodeURIComponent;

/** The first entry of a page's transcript is the page itself; the rest are comments. */
const commentOf = (target: DevTarget) => (target.index === 0 ? undefined : target.entries[target.index]?.id);

/** The discussion a comment is in. */
async function discussionOf(api: DevApi, target: DevTarget): Promise<string | undefined> {
  const comment = commentOf(target);
  if (comment === undefined) return undefined;
  const discussions = await api.get<Array<{ id: string }>>(`/pages/${segment(target.place.id)}/discussions`);
  for (const discussion of discussions) {
    const comments = await api.get<Array<{ id: string }>>(`/discussions/${segment(discussion.id)}/comments`);
    if (comments.some((known) => known.id === comment)) return discussion.id;
  }
  return undefined;
}

/** Notion in the dev tools: a place is a page, by its title, connected to the integration. */
export const notionDev: DevAdapter = {
  place: "page",
  example: '"Roadmap"',
  resource: "NotionPage",
  listing: { path: "/pages", id: "{id}", name: ["{title}"], transcript: "/pages/{id}/transcript" },
  personBody: (name) => ({ name }),
  async create({ api, person, app, name, text }) {
    const page = await api.post<{ id: string }>("/pages", { title: name, connections: [app.id], createdBy: person.id });
    if (text !== undefined) await api.post(`/users/${segment(person.id)}/comment`, { text, page: page.id });
    return page;
  },
  async say({ api, place, person, text }) {
    await api.post(`/users/${segment(person.id)}/comment`, { text, page: place.id });
  },
  // On the page itself, a new discussion; on a comment, a reply in its discussion.
  async reply({ api, target, person, text }) {
    const discussion = await discussionOf(api, target);
    await api.post(
      `/users/${segment(person.id)}/${discussion === undefined ? "comment" : "reply"}`,
      discussion === undefined ? { text, page: target.place.id } : { text, discussion },
    );
  },
  async refs(api, target) {
    const comment = commentOf(target);
    const discussion = await discussionOf(api, target);
    return {
      NotionPage: target.place.id,
      ...(comment === undefined ? {} : { NotionComment: comment }),
      ...(discussion === undefined ? {} : { NotionDiscussion: discussion }),
    };
  },
  async thread(api, target) {
    const discussion = await discussionOf(api, target);
    return discussion === undefined ? undefined : `/discussions/${segment(discussion)}/transcript`;
  },
};
