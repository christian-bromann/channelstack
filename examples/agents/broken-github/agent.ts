/**
 * A GitHub App with one switchable fault per standard check. With `BROKEN` unset it does
 * everything right; with `BROKEN=github.redelivery` (any check id) it has exactly the bug that
 * check exists to catch. The test suite uses it to prove that each check fails when it should.
 */
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";

import * as agent from "../shared/github.ts";
import { serve } from "../shared/serve.ts";

const { GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, GITHUB_API_URL, PORT } = process.env;
if (!GITHUB_APP_ID || !GITHUB_PRIVATE_KEY || !GITHUB_WEBHOOK_SECRET || !PORT) {
  throw new Error("The agent needs GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET and PORT");
}
const fault = process.env.BROKEN ?? "";
const broken = (check: string) => fault === check;

const webhooks = new Webhooks({ secret: GITHUB_WEBHOOK_SECRET });
const rest = (payload: { installation?: { id: number } }) =>
  new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: GITHUB_APP_ID,
      privateKey: GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n"),
      installationId: payload.installation?.id ?? 0,
    },
    ...(GITHUB_API_URL ? { baseUrl: GITHUB_API_URL } : {}),
  }).rest;
const at = (payload: { repository: { owner: { login: string }; name: string } }) => ({
  owner: payload.repository.owner.login,
  repo: payload.repository.name,
});

/** How often it answered in an issue, so that the loop this fault starts ends by itself. */
const answered = new Map<string, number>();

webhooks.on("issue_comment.created", async ({ payload }) => {
  const { comment, issue, sender, repository } = payload;
  const key = `${repository.full_name}#${issue.number}`;
  // Bug: answers every comment, its own included (three times, then it stops, so the test ends).
  const own = broken("github.ignores-own-comments") && (answered.get(key) ?? 0) < 3;
  if (!own && (sender.type === "Bot" || !agent.mentions(comment.body))) return;
  answered.set(key, (answered.get(key) ?? 0) + 1);
  await agent.triage(rest(payload), at(payload), issue.number);
  // Bug: says it twice.
  if (broken("github.one-comment")) await agent.triage(rest(payload), at(payload), issue.number);
});

webhooks.on("pull_request_review_comment.created", async ({ payload }) => {
  const { comment, pull_request: pull, sender } = payload;
  // Bug: only listens to the conversation, not to threads on the diff.
  if (broken("github.review-thread")) return;
  if (sender.type === "Bot" || !agent.mentions(comment.body)) return;
  await agent.answerInThread(rest(payload), at(payload), pull.number, comment.id);
});

webhooks.on("pull_request.opened", async ({ payload }) => {
  const { head } = payload.pull_request;
  // Bug: starts a check run and never finishes it.
  const state = broken("github.check-conclusion")
    ? ({ status: "in_progress" } as const)
    : ({ status: "completed", conclusion: "success" } as const);
  await rest(payload).checks.create({ ...at(payload), name: agent.words.check, head_sha: head.sha, ...state });
});

const handled = new Set<string>();

serve(Number(PORT), "/api/webhooks/github", async (request, body) => {
  const id = request.headers.get("x-github-delivery") ?? "";
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  // Bug: trusts whoever posts to its endpoint.
  if (!broken("github.bad-signature") && !(await webhooks.verify(body, signature))) {
    return new Response("bad signature", { status: 401 });
  }
  // Bug: takes a redelivery for a new event.
  if (handled.has(id) && !broken("github.redelivery")) return new Response("seen", { status: 200 });
  handled.add(id);
  const name = request.headers.get("x-github-event") ?? "";
  void webhooks
    .receive({ id, name, payload: JSON.parse(body) } as Parameters<typeof webhooks.receive>[0])
    .catch(console.error);
  return new Response("ok", { status: 202 });
});
