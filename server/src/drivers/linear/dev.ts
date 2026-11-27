import { type DevAdapter, type DevApi, DevRefusal, devRoot, type DevTarget } from "../../core/dev/index.ts";

/** The team the dev tools make issues in. Anyone but a guest may act in any team. */
const DEV_TEAM = "Dev";
const segment = encodeURIComponent;

/**
 * The comment an entry is, if it is one: the first entry of an issue's transcript is the issue
 * itself, and an agent's activities in a session aren't comments.
 */
async function commentOf(api: DevApi, target: DevTarget, entry = target.entries[target.index]) {
  if (target.index === 0 || entry === undefined) return undefined;
  const comments = await api.get<Array<{ id: string }>>(`/issues/${segment(issueOf(target).id)}/comments`);
  return comments.some((comment) => comment.id === entry.id) ? entry.id : undefined;
}
/** An issue as `/issues` lists it. */
const issueOf = (target: DevTarget) => target.place.item.issue as { id: string; team: { id: string } };

/** Linear in the dev tools: a place is an issue, by its title, in a team named Dev. */
export const linearDev: DevAdapter = {
  place: "issue",
  example: '"Crash on login"',
  resource: "LinearIssue",
  listing: {
    path: "/issues",
    id: "{issue.identifier}",
    name: ["{title}"],
    transcript: "/issues/{issue.id}/transcript",
  },
  personBody: (name) => ({ name }),
  async create({ api, person, name, text }) {
    const teams = await api.get<Array<{ id: string; name: string }>>("/teams");
    const team =
      teams.find((known) => known.name === DEV_TEAM) ??
      (await api.post<{ id: string }>("/teams", { name: DEV_TEAM, members: [person.id] }));
    const issue = await api.post(`/users/${segment(person.id)}/issues`, {
      issue: { title: name, ...(text === undefined ? {} : { description: text }) },
      team: team.id,
    });
    return { issue, title: name };
  },
  async say({ api, place, person, text }) {
    await api.post(`/users/${segment(person.id)}/comment`, {
      body: text,
      issue: (place.item.issue as { id: string }).id,
    });
  },
  // On the issue itself, a new comment; on a comment, a reply in its thread.
  async reply({ api, target, person, text }) {
    const comment = await commentOf(api, target);
    if (comment === undefined) {
      await api.post(`/users/${segment(person.id)}/comment`, { body: text, issue: issueOf(target).id });
      return;
    }
    // A reply is in the thread of the comment that started it.
    const root = (await commentOf(api, target, devRoot(target))) ?? comment;
    await api.post(`/users/${segment(person.id)}/reply`, { body: text, comment: root });
  },
  async react({ api, target, person, emoji }) {
    const comment = await commentOf(api, target);
    if (comment === undefined) throw new DevRefusal("on Linear people react to comments: pick one with `--on`.");
    await api.post(`/users/${segment(person.id)}/react`, { emoji, comment });
  },
  async refs(api, target) {
    const comment = await commentOf(api, target);
    const issue = issueOf(target);
    // The issue's newest agent session: what a person prompts or stops.
    const sessions = await api.get<Array<{ id: string }>>(`/issues/${segment(issue.id)}/sessions`);
    const session = sessions.at(-1)?.id;
    return {
      LinearIssue: issue.id,
      LinearTeam: issue.team.id,
      ...(session === undefined ? {} : { LinearAgentSession: session }),
      ...(comment === undefined ? {} : { LinearComment: comment }),
    };
  },
  async thread(api, target) {
    const root = await commentOf(api, target, devRoot(target));
    return root === undefined ? undefined : `/comments/${segment(root)}/transcript`;
  },
};
