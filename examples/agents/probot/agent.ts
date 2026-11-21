/**
 * A GitHub App on Probot, written the way Probot's docs show. It is configured from the
 * environment `channelstack env` prints and talks to whatever `GITHUB_API_URL` points at: the
 * fake in tests, GitHub itself when the variable is unset.
 */
import { Probot, Server } from "probot";

import * as agent from "../shared/github.ts";

const { GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, GITHUB_API_URL, PORT } = process.env;
if (!GITHUB_APP_ID || !GITHUB_PRIVATE_KEY || !GITHUB_WEBHOOK_SECRET || !PORT) {
  throw new Error("The agent needs GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET and PORT");
}

/**
 * Probot's Octokit, as the REST methods the shared workflows are written against. Probot ships a
 * newer generation of the same methods than `@octokit/rest`; the calls used here are the same in both.
 */
const rest = (context: { octokit: unknown }) => (context.octokit as { rest: agent.Rest }).rest;

/** Deliveries already handled, by GUID: a redelivery is the same event again, not a new one. */
const handled = new Set<string>();
const firstTime = (id: string) => !handled.has(id) && handled.add(id).size > 0;

function app(probot: Probot): void {
  probot.on("issue_comment.created", async (context) => {
    const { comment, issue, sender } = context.payload;
    // Its own comments, and other bots', are not for it.
    if (sender.type === "Bot" || !agent.mentions(comment.body) || !firstTime(context.id)) return;
    const at = context.repo();
    if (issue.pull_request && /\breview\b/i.test(comment.body)) return agent.review(rest(context), at, issue.number);
    if (/\bduplicate\b/i.test(comment.body)) return agent.duplicate(rest(context), at, issue);
    return agent.triage(rest(context), at, issue.number);
  });

  probot.on("issues.labeled", async (context) => {
    if (context.payload.label?.name !== "agent:fix" || !firstTime(context.id)) return;
    await agent.fixTypo(rest(context), context.repo(), context.payload.issue.number);
  });

  probot.on("pull_request_review_comment.created", async (context) => {
    const { comment, pull_request: pull, sender } = context.payload;
    if (sender.type === "Bot" || !agent.mentions(comment.body) || !firstTime(context.id)) return;
    await agent.answerInThread(rest(context), context.repo(), pull.number, comment.id);
  });

  probot.on("pull_request_review.submitted", async (context) => {
    const { review, pull_request: pull, sender } = context.payload;
    if (sender.type === "Bot" || review.state !== "changes_requested" || !agent.mentions(review.body)) return;
    if (firstTime(context.id)) await agent.addressReview(rest(context), context.repo(), pull.number);
  });

  probot.on(["pull_request.opened", "pull_request.synchronize"], async (context) => {
    if (!firstTime(context.id)) return;
    const { number, head } = context.payload.pull_request;
    const opened = context.payload.action === "opened";
    await agent.check(rest(context), context.repo(), { number, sha: head.sha }, opened);
  });

  probot.on("check_run.requested_action", async (context) => {
    const { check_run: run, requested_action: action } = context.payload;
    if (action?.identifier !== "autofix" || !firstTime(context.id)) return;
    await agent.autofix(rest(context), context.repo(), run.head_sha);
  });
}

const server = new Server({
  Probot: Probot.defaults({
    appId: GITHUB_APP_ID,
    // A PEM in one line, with `\n` for its line breaks: how most deploy targets take it.
    privateKey: GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n"),
    secret: GITHUB_WEBHOOK_SECRET,
    ...(GITHUB_API_URL ? { baseUrl: GITHUB_API_URL } : {}),
    logLevel: "error",
  }),
  port: Number(PORT),
  webhookPath: "/api/github/webhooks",
});
await server.load(app);
await server.start();
