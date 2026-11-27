import { type DevAdapter, DevRefusal, devRoot, type DevTarget } from "../../core/dev/index.ts";

/** The team the dev tools make issues in. Anyone but a guest may act in any team. */
const DEV_TEAM = "Dev";
const segment = encodeURIComponent;

/** The first entry of an issue's transcript is the issue itself; the rest are comments and their replies. */
const commentOf = (target: DevTarget) => (target.index === 0 ? undefined : target.entries[target.index]?.id);
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
    if (commentOf(target) === undefined) {
      await api.post(`/users/${segment(person.id)}/comment`, { body: text, issue: issueOf(target).id });
      return;
    }
    await api.post(`/users/${segment(person.id)}/reply`, { body: text, comment: devRoot(target).id });
  },
  async react({ api, target, person, emoji }) {
    const comment = commentOf(target);
    if (comment === undefined) throw new DevRefusal("on Linear people react to comments: pick one with `--on`.");
    await api.post(`/users/${segment(person.id)}/react`, { emoji, comment });
  },
  async refs(_api, target) {
    const comment = commentOf(target);
    const issue = issueOf(target);
    return {
      LinearIssue: issue.id,
      LinearTeam: issue.team.id,
      ...(comment === undefined ? {} : { LinearComment: comment }),
    };
  },
  thread: async (_api, target) =>
    commentOf(target) === undefined ? undefined : `/comments/${segment(devRoot(target).id)}/transcript`,
};
