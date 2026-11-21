/**
 * A reference agent: a GitHub App on the Chat SDK and its GitHub adapter, as a developer would
 * write it. Conversations (a mention in an issue, a pull request or a thread on the diff) go
 * through the Chat SDK; what GitHub has beyond conversations (labels, reviews, checks) is handled
 * next to it with Octokit's own webhook receiver. It behaves like the Probot reference agent and
 * has no channelstack code in it. Configuration comes from the environment (`channelstack env`).
 */
import { createGitHubAdapter } from "@chat-adapter/github";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";
import { Chat } from "chat";

import * as agent from "../shared/github.ts";
import { serve } from "../shared/serve.ts";

const { GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, GITHUB_API_URL, PORT } = process.env;
if (!GITHUB_APP_ID || !GITHUB_PRIVATE_KEY || !GITHUB_WEBHOOK_SECRET || !PORT) {
  throw new Error("The agent needs GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET and PORT");
}
// A PEM in one line, with `\n` for its line breaks: how most deploy targets take it.
const privateKey = GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n");

const github = createGitHubAdapter({
  appId: GITHUB_APP_ID,
  privateKey,
  webhookSecret: GITHUB_WEBHOOK_SECRET,
  userName: agent.AGENT,
});
const bot = new Chat({ userName: agent.AGENT, adapters: { github }, state: createMemoryState(), logger: "warn" });

/** Octokit as the App's installation, for what isn't a conversation. */
const octokit = (installationId: number) =>
  new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: GITHUB_APP_ID, privateKey, installationId },
    ...(GITHUB_API_URL ? { baseUrl: GITHUB_API_URL } : {}),
  });

bot.onNewMention(async (thread, message) => {
  const { owner, repo, prNumber, reviewCommentId, type } = github.decodeThreadId(thread.id);
  // A mention in a thread on the diff is answered there.
  if (reviewCommentId !== undefined) return void (await thread.post(agent.words.thread));
  const { rest } = await clientFor(owner, repo);
  if (type !== "issue" && /\breview\b/i.test(message.text)) return agent.review(rest, { owner, repo }, prNumber);
  if (/\bduplicate\b/i.test(message.text)) {
    const { data: issue } = await rest.issues.get({ owner, repo, issue_number: prNumber });
    return agent.duplicate(rest, { owner, repo }, issue);
  }
  await thread.post(agent.words.triage);
});

/** Octokit for a repository, as the App's installation there. */
async function clientFor(owner: string, repo: string): Promise<Octokit> {
  const app = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: GITHUB_APP_ID, privateKey },
    ...(GITHUB_API_URL ? { baseUrl: GITHUB_API_URL } : {}),
  });
  const { data: installation } = await app.rest.apps.getRepoInstallation({ owner, repo });
  return octokit(installation.id);
}

const webhooks = new Webhooks({ secret: GITHUB_WEBHOOK_SECRET });
const at = (payload: { repository: { owner: { login: string }; name: string } }) => ({
  owner: payload.repository.owner.login,
  repo: payload.repository.name,
});
const restOf = (payload: { installation?: { id: number } }) => octokit(payload.installation?.id ?? 0).rest;

webhooks.on("issues.labeled", async ({ payload }) => {
  if (payload.label?.name === "agent:fix") await agent.fixTypo(restOf(payload), at(payload), payload.issue.number);
});

webhooks.on("pull_request_review.submitted", async ({ payload }) => {
  const { review, pull_request: pull, sender } = payload;
  if (sender.type === "Bot" || review.state !== "changes_requested" || !agent.mentions(review.body)) return;
  await agent.addressReview(restOf(payload), at(payload), pull.number);
});

webhooks.on(["pull_request.opened", "pull_request.synchronize"], async ({ payload }) => {
  const { number, head } = payload.pull_request;
  await agent.check(restOf(payload), at(payload), { number, sha: head.sha }, payload.action === "opened");
});

webhooks.on("check_run.requested_action", async ({ payload }) => {
  if (payload.requested_action?.identifier !== "autofix") return;
  await agent.autofix(restOf(payload), at(payload), payload.check_run.head_sha);
});

/** Deliveries already handled, by GUID: a redelivery is the same event again, not a new one. */
const handled = new Set<string>();

serve(Number(PORT), "/api/webhooks/github", async (request, body) => {
  const id = request.headers.get("x-github-delivery") ?? "";
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  // The exact bytes are verified before anything is read from them.
  if (!(await webhooks.verify(body, signature))) return new Response("bad signature", { status: 401 });
  if (handled.has(id)) return new Response("seen", { status: 200 });
  handled.add(id);
  const name = request.headers.get("x-github-event") ?? "";
  // Acknowledge first, then work: GitHub waits ten seconds for an answer.
  void webhooks
    .receive({ id, name, payload: JSON.parse(body) } as Parameters<typeof webhooks.receive>[0])
    .catch(console.error);
  return bot.webhooks.github(request);
});
