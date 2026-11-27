import { type DevAdapter, type DevApi, type DevPrincipal, DevRefusal, type DevTarget } from "../../core/dev/index.ts";
import { REACTIONS } from "./world.ts";

interface Repo {
  readonly id: string;
  readonly name: string;
}
/** An issue as `/issues` lists it. */
interface Listed {
  readonly issue: { readonly repoId: string; readonly number: number };
  readonly pullRequest: boolean;
  readonly updatedAt: string;
}

/**
 * The repository the dev tools open issues in: public, so anyone may open and comment on one, with
 * the App installed. Whoever first acts on GitHub in the dev session made it, and is its admin:
 * they may push, label and merge; the others may what anyone may on a public repository.
 */
const DEV_REPO = "dev";
const segment = encodeURIComponent;

async function devRepo(api: DevApi, app: DevPrincipal, person: DevPrincipal): Promise<Repo> {
  const repos = await api.get<Repo[]>("/repos");
  return (
    repos.find((repo) => repo.name === DEV_REPO) ??
    api.post<Repo>("/repos", {
      name: DEV_REPO,
      private: false,
      apps: [app.id],
      collaborators: [{ user: person.id, permission: "admin" }],
    })
  );
}

const listed = (item: unknown) => item as Listed;
const issueRef = (target: DevTarget) => {
  const { issue } = listed(target.place.item);
  return { repoId: issue.repoId, number: issue.number };
};
/**
 * What an entry of an issue's transcript is: the first is the issue itself; then a comment in the
 * conversation, a comment on the diff, or a review's verdict, which no handle stands for.
 */
async function entryOf(api: DevApi, target: DevTarget): Promise<"issue" | "comment" | "reviewComment" | "review"> {
  if (target.index === 0) return "issue";
  const id = target.entries[target.index]?.id;
  const { issue, pullRequest } = listed(target.place.item);
  const comments = await api.get<Array<{ id: number }>>(
    `/repos/${segment(issue.repoId)}/issues/${issue.number}/comments`,
  );
  if (comments.some((comment) => String(comment.id) === id)) return "comment";
  if (!pullRequest) return "review";
  const onTheDiff = await api.get<Array<{ id: number }>>(
    `/repos/${segment(issue.repoId)}/pulls/${issue.number}/review-comments`,
  );
  return onTheDiff.some((comment) => String(comment.id) === id) ? "reviewComment" : "review";
}

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
    id: "{issue.repo.name}#{issue.number}",
    name: ({ title }) => String(title ?? ""),
    transcript: "/repos/{issue.repoId}/issues/{issue.number}/transcript",
  },
  personBody: (name) => ({ login: name }),
  // GitHub writes times to the second. The newest entry of an issue is what last changed it, so
  // within that second, when the issue changed is when it was written.
  time(entry, place) {
    const written = Date.parse(entry.at);
    const changed = Date.parse(listed(place.item).updatedAt);
    return Math.floor(changed / 1000) === Math.floor(written / 1000) ? changed : written;
  },
  async create({ api, person, app, name, text }) {
    const repo = await devRepo(api, app, person);
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
    const entry = await entryOf(api, target);
    if (entry === "review") throw new DevRefusal("that entry is a review's verdict: react to a comment, or the issue.");
    const id = Number(target.entries[target.index]?.id);
    await api.post(`/users/${segment(person.id)}/react`, {
      content: (REACTIONS as readonly string[]).includes(content) ? content : emoji,
      ...(entry === "issue" ? { issue: issueRef(target) } : { comment: id }),
    });
  },
  async refs(api, target) {
    const issue = issueRef(target);
    const entry = await entryOf(api, target);
    const id = Number(target.entries[target.index]?.id);
    return {
      GitHubRepo: issue.repoId,
      GitHubIssue: issue,
      ...(listed(target.place.item).pullRequest ? { GitHubPullRequest: issue } : {}),
      ...(entry === "comment" ? { GitHubComment: id } : {}),
      ...(entry === "reviewComment" ? { GitHubReviewComment: id } : {}),
    };
  },
};
