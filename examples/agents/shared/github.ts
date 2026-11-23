/**
 * What the GitHub reference agents do, written once against Octokit's REST methods so the Probot
 * agent and the Chat SDK agent behave the same: triage a mention, spot a duplicate, fix a typo in
 * a pull request of its own, review a diff, answer in a review thread, address a review, and
 * report on pushed code with a check run.
 */
import type { Octokit } from "@octokit/rest";

/** Octokit's REST methods: `octokit.rest`. */
export type Rest = Octokit["rest"];

export type RepoRef = { owner: string; repo: string };

/** The name people mention the agent by: its App's slug. */
export const AGENT = process.env.GITHUB_APP_SLUG ?? "my-agent";
const MENTION = new RegExp(`@${AGENT}\\b`, "i");
export const mentions = (text: string | null | undefined): boolean => MENTION.test(text ?? "");

export const words = {
  triage: "Thanks, I'll triage this.",
  reviewed: "I left a review on the diff.",
  review: "A few notes on the changes.",
  inline: "This line is new: is it covered by a test?",
  thread: "Good question. I looked at it, and it is needed by the callers of this module.",
  duplicate: (number: number) => `This looks like a duplicate of #${number}.`,
  pullRequest: (number: number) => `I opened a pull request: #${number}`,
  fixed: "Address review feedback",
  check: "my-agent",
};

/** A statement that assigns nothing: `const broken = ;`. What the agent's check looks for. */
const BROKEN = /=\s*;/;
const utf8 = (base64: string) => Buffer.from(base64, "base64").toString("utf8");
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** A file's text on a branch, with the blob sha an update needs. */
async function readFile(rest: Rest, at: RepoRef, path: string, ref: string) {
  const { data } = await rest.repos.getContent({ ...at, path, ref });
  if (Array.isArray(data) || data.type !== "file") throw new Error(`${path} is not a file`);
  return { text: utf8(data.content), sha: data.sha };
}

/** Answer a mention in an issue or a pull request's conversation. */
export async function triage(rest: Rest, at: RepoRef, issue: number): Promise<void> {
  await rest.issues.createComment({ ...at, issue_number: issue, body: words.triage });
}

/** "Is this a duplicate?": an older open issue about the same thing gets this one labelled and closed. */
export async function duplicate(rest: Rest, at: RepoRef, issue: { number: number; title: string }): Promise<void> {
  const subject = (title: string) => new Set(title.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const mine = subject(issue.title);
  const { data: open } = await rest.issues.listForRepo({ ...at, state: "open" });
  const original = open.find(
    (other) => other.number < issue.number && [...subject(other.title)].filter((word) => mine.has(word)).length >= 2,
  );
  if (!original)
    return void (await rest.issues.createComment({ ...at, issue_number: issue.number, body: words.triage }));
  await rest.issues.addLabels({ ...at, issue_number: issue.number, labels: ["duplicate"] });
  await rest.issues.createComment({ ...at, issue_number: issue.number, body: words.duplicate(original.number) });
  await rest.issues.update({ ...at, issue_number: issue.number, state: "closed", state_reason: "not_planned" });
}

/** The `agent:fix` label: fix the README's typo on a branch of its own and open a pull request for it. */
export async function fixTypo(rest: Rest, at: RepoRef, issue: number): Promise<void> {
  const { data: repo } = await rest.repos.get(at);
  const { data: base } = await rest.git.getRef({ ...at, ref: `heads/${repo.default_branch}` });
  const branch = `${AGENT}/fix-${issue}`;
  await rest.git.createRef({ ...at, ref: `refs/heads/${branch}`, sha: base.object.sha });
  const readme = await readFile(rest, at, "README.md", branch);
  const fixed = readme.text.includes("teh") ? readme.text.replaceAll("teh", "the") : `${readme.text}\nSee #${issue}.\n`;
  await rest.repos.createOrUpdateFileContents({
    ...at,
    path: "README.md",
    branch,
    sha: readme.sha,
    message: `Fix the README (#${issue})`,
    content: base64(fixed),
  });
  const { data: pull } = await rest.pulls.create({
    ...at,
    head: branch,
    base: repo.default_branch,
    title: `Fix the README (#${issue})`,
    body: `Fixes #${issue}.`,
  });
  await rest.issues.createComment({ ...at, issue_number: issue, body: words.pullRequest(pull.number) });
}

/** "Review this": a review with one comment on the first changed line, and one line in the conversation. */
export async function review(rest: Rest, at: RepoRef, pull: number): Promise<void> {
  const { data: files } = await rest.pulls.listFiles({ ...at, pull_number: pull });
  // The first line the pull request adds: where its first hunk starts on the new side.
  const comments = files.flatMap((file) => {
    const start = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(file.patch ?? "")?.[1];
    return start === undefined ? [] : [{ path: file.filename, line: Number(start), side: "RIGHT", body: words.inline }];
  });
  await rest.pulls.createReview({
    ...at,
    pull_number: pull,
    event: "COMMENT",
    body: words.review,
    comments: comments.slice(0, 1),
  });
  await rest.issues.createComment({ ...at, issue_number: pull, body: words.reviewed });
}

/** A mention in a thread on the diff: answer in the same thread. */
export async function answerInThread(rest: Rest, at: RepoRef, pull: number, comment: number): Promise<void> {
  await rest.pulls.createReplyForReviewComment({ ...at, pull_number: pull, comment_id: comment, body: words.thread });
}

/** Changes were requested: push a commit to the pull request's branch that addresses them. */
export async function addressReview(rest: Rest, at: RepoRef, pull: number): Promise<void> {
  const { data } = await rest.pulls.get({ ...at, pull_number: pull });
  const [file] = (await rest.pulls.listFiles({ ...at, pull_number: pull })).data;
  if (!file) return;
  const current = await readFile(rest, at, file.filename, data.head.ref);
  await rest.repos.createOrUpdateFileContents({
    ...at,
    path: file.filename,
    branch: data.head.ref,
    sha: current.sha,
    message: words.fixed,
    content: base64(`${current.text.trimEnd()}\n// Reviewed: named as discussed.\n`),
  });
}

/** What is wrong with the files a pull request changes: one annotation per statement that assigns nothing. */
async function problems(rest: Rest, at: RepoRef, pull: number, ref: string) {
  const { data: files } = await rest.pulls.listFiles({ ...at, pull_number: pull });
  const found = [];
  for (const file of files.filter((candidate) => candidate.status !== "removed")) {
    const { text } = await readFile(rest, at, file.filename, ref);
    for (const [index, line] of text.split("\n").entries()) {
      if (!BROKEN.test(line)) continue;
      found.push({
        path: file.filename,
        start_line: index + 1,
        end_line: index + 1,
        annotation_level: "failure" as const,
        message: "Expression expected",
      });
    }
  }
  return found;
}

/**
 * Check a pull request's newest commit. A new pull request with a problem offers to fix it
 * (`action_required`, with a button); later pushes just pass or fail.
 */
export async function check(
  rest: Rest,
  at: RepoRef,
  pull: { number: number; sha: string },
  offerFix: boolean,
): Promise<void> {
  const annotations = await problems(rest, at, pull.number, pull.sha);
  const failed = annotations.length > 0;
  await rest.checks.create({
    ...at,
    name: words.check,
    head_sha: pull.sha,
    status: "completed",
    conclusion: failed ? (offerFix ? "action_required" : "failure") : "success",
    output: {
      title: failed ? `${annotations.length} problem${annotations.length === 1 ? "" : "s"}` : "No problems",
      summary: failed ? "Some statements assign nothing." : "Everything parses.",
      annotations,
    },
    ...(failed && offerFix
      ? { actions: [{ label: "Fix it", description: "Let the agent fix it", identifier: "autofix" }] }
      : {}),
  });
}

/** The "Fix it" button on a check run: fix the statements on the branch the commit is on. */
export async function autofix(rest: Rest, at: RepoRef, sha: string): Promise<void> {
  const { data: open } = await rest.pulls.list({ ...at, state: "open" });
  const pull = open.find((candidate) => candidate.head.sha === sha);
  if (!pull) return;
  for (const { path } of await problems(rest, at, pull.number, sha)) {
    const file = await readFile(rest, at, path, pull.head.ref);
    await rest.repos.createOrUpdateFileContents({
      ...at,
      path,
      branch: pull.head.ref,
      sha: file.sha,
      message: `Fix ${path}`,
      content: base64(file.text.replace(/=\s*;/g, "= undefined;")),
    });
  }
}
