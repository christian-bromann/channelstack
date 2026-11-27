import type { DevAdapter, DevApi, DevPrincipal, DevTarget } from "../../core/dev/index.ts";
import { REACTIONS } from "./world.ts";

interface Repo {
  readonly id: string;
  readonly name: string;
}
/** An issue as `/issues` lists it. */
interface Listed {
  readonly issue: { readonly repoId: string; readonly number: number };
  readonly pullRequest: boolean;
}

/** The repository the dev tools open issues in: public, so anyone may, with the App installed. */
const DEV_REPO = "dev";
const segment = encodeURIComponent;

async function devRepo(api: DevApi, app: DevPrincipal): Promise<Repo> {
  const repos = await api.get<Repo[]>("/repos");
  return (
    repos.find((repo) => repo.name === DEV_REPO) ??
    api.post<Repo>("/repos", { name: DEV_REPO, private: false, apps: [app.id] })
  );
}

const listed = (item: unknown) => item as Listed;
const issueRef = (target: DevTarget) => {
  const { issue } = listed(target.place.item);
  return { repoId: issue.repoId, number: issue.number };
};
/** The first entry of an issue's transcript is the issue itself; the rest are comments. */
const commentOf = (target: DevTarget) => (target.index === 0 ? undefined : Number(target.entries[target.index]?.id));

/** `:eyes:`, `eyes` and `👀` alike, as GitHub's reaction names. */
function reaction(emoji: string): string {
  const name = emoji.replace(/^:|:$/g, "");
  const known = { thumbsup: "+1", thumbsdown: "-1", tada: "hooray", "👍": "+1", "👎": "-1", "👀": "eyes" }[name];
  return known ?? name;
}

/** GitHub in the dev tools: a place is an issue or a pull request, by its title, in the org's `dev` repository. */
export const githubDev: DevAdapter = {
  place: "issue",
  example: '"Login fails"',
  resource: "GitHubIssue",
  listing: {
    path: "/issues",
    id: "{issue.repo.fullName}#{issue.number}",
    name: ["{title}"],
    transcript: "/repos/{issue.repoId}/issues/{issue.number}/transcript",
  },
  personBody: (name) => ({ login: name }),
  async create({ api, person, app, name, text }) {
    const repo = await devRepo(api, app);
    const issue = await api.post(`/users/${segment(person.id)}/issues`, {
      issue: { title: name, body: text ?? "" },
      repo: repo.id,
    });
    return { issue, title: name, pullRequest: false };
  },
  async say({ api, place, person, text }) {
    const { issue } = listed(place.item);
    await api.post(`/users/${segment(person.id)}/comment`, {
      body: text,
      issue: { repoId: issue.repoId, number: issue.number },
    });
  },
  // A reply is a comment in the conversation; a reply on the diff is `act reply`.
  async reply({ api, target, person, text }) {
    await api.post(`/users/${segment(person.id)}/comment`, { body: text, issue: issueRef(target) });
  },
  async react({ api, target, person, emoji }) {
    const content = reaction(emoji);
    const comment = commentOf(target);
    await api.post(`/users/${segment(person.id)}/react`, {
      content: (REACTIONS as readonly string[]).includes(content) ? content : emoji,
      ...(comment === undefined ? { issue: issueRef(target) } : { comment }),
    });
  },
  async refs(_api, target) {
    const issue = issueRef(target);
    const comment = commentOf(target);
    return {
      GitHubRepo: issue.repoId,
      GitHubIssue: issue,
      ...(listed(target.place.item).pullRequest ? { GitHubPullRequest: issue } : {}),
      ...(comment === undefined ? {} : { GitHubComment: comment, GitHubReviewComment: comment }),
    };
  },
};
