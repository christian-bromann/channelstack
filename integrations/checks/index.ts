/**
 * `channelstack/checks`: the standard behaviour checks. Calling one registers ordinary tests in
 * the suite that is running, on the fixtures and matchers of `channelstack/vitest`:
 *
 *   import { slackChecks } from "channelstack/checks";
 *   slackChecks({ app: "my-agent" });
 *
 * Each check is something agents commonly get wrong, written against the public API only.
 */
import { describe, expect, test, type TestContext } from "vitest";

import type {
  Duration,
  GitHubApp,
  GitHubDelivery,
  GitHubFixture,
  LinearApp,
  LinearFixture,
  NotionDelivery,
  NotionFixture,
  NotionIntegration,
  SlackApp,
  SlackFixture,
  SlackMessage,
} from "../../sdks/typescript/client.ts";
// The fixtures and matchers the checks use come from the Vitest integration.
import type {} from "../vitest/index.ts";

export interface ChecksOptions {
  /** The app's name, as people mention it. */
  app: string;
  /** Text that makes the agent reply. Default: `@<app> hello`. */
  prompt?: string;
  /**
   * Text that makes the agent stream a longer answer, in a DM. Without it the stream and Stop
   * checks are left out: not every agent streams.
   */
  streamPrompt?: string;
  /**
   * Text that makes the agent ask for an approval, and the label of the button it shows. A
   * workspace admin may press it; anyone else may not. Without it the click checks are left out.
   */
  approval?: { prompt: string; button: string };
  /** Leave out checks by id, e.g. `["slack.stream-stop"]`. */
  skip?: string[];
  /** How long each check waits for the agent. Default: the integration's timeout. */
  timeout?: Duration;
  /**
   * How many times the agent may answer another app that answers everything, with no person
   * between them, before `<channel>.no-reply-loop` fails (decision 0027). Default: 3.
   */
  loopTurns?: number;
}

/** `toGoQuiet`'s bound from a check's wait. */
const within = (wait: { timeout?: Duration }) => (wait.timeout === undefined ? {} : { within: wait.timeout });

/** The ids of the Slack checks, in the order they are registered. */
export const SLACK_CHECKS = [
  "slack.dm-once",
  "slack.mention-once",
  "slack.in-thread",
  "slack.retry",
  "slack.redelivery",
  "slack.ignores-bots",
  "slack.no-reply-loop",
  "slack.bad-signature",
  "slack.ack",
  "slack.msg-too-long",
  "slack.stream-stop",
  "slack.stop",
  "slack.click-unauthorized",
  "slack.double-click",
] as const;

/** The ids of the GitHub checks, in the order they are registered. */
export const GITHUB_CHECKS = [
  "github.ignores-own-comments",
  "github.one-comment",
  "github.review-thread",
  "github.redelivery",
  "github.check-run",
  "github.bad-signature",
  "github.no-reply-loop",
] as const;

/** The ids of the Linear checks, in the order they are registered. */
export const LINEAR_CHECKS = [
  "linear.first-activity",
  "linear.ends-turn",
  "linear.stop",
  "linear.redelivery",
  "linear.stale",
  "linear.bad-signature",
  "linear.no-reply-loop",
] as const;

/** The ids of the Notion checks, in the order they are registered. */
export const NOTION_CHECKS = [
  "notion.reply-in-discussion",
  "notion.ignores-own-comments",
  "notion.redelivery",
  "notion.bad-signature",
  "notion.no-reply-loop",
] as const;

/** The ids of the Resend checks, in the order they are registered. */
export const RESEND_CHECKS = [
  "resend.reply-in-thread",
  "resend.redelivery",
  "resend.bad-signature",
  "resend.stale",
] as const;

/** The ids of the Google checks, in the order they are registered. */
export const GOOGLE_CHECKS = [
  "google.reply-in-thread",
  "google.history",
  "google.redelivery",
  "google.bad-signature",
  "google.wrong-audience",
  "google.stale",
] as const;

/**
 * The delivery a check retries, redelivers, forges or times: the one thing every delivery check
 * needs, on every channel. Live, the platform delivers to the agent itself and channelstack has no
 * delivery to show (reality-matrix.md), so the check skips with that reason, through the test's own
 * `skip` as every live refusal does, before it waits for anything else.
 */
const deliveryOf = <D>(subject: { readonly delivery?: D | undefined }, { skip }: TestContext, platform: string): D =>
  subject.delivery ?? skip(`live: ${platform} delivers to the agent itself, so delivery checks are fake-only`);

/**
 * Registers one check as a test, with its id in the name. A check that was skipped, or whose
 * prompt wasn't given, is left out. An id in `skip` that no check has is a mistake worth hearing about.
 */
const registrar = <Id extends string>(options: ChecksOptions, ids: readonly Id[]) => {
  const unknown = (options.skip ?? []).filter((id) => !(ids as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `No check is called ${unknown.map((id) => `"${id}"`).join(", ")}. The checks are: ${ids.join(", ")}`,
    );
  }
  // `needs` is a rest argument: a default value would turn the `undefined` of a missing option into a value.
  return (id: Id, title: string, run: (context: TestContext) => Promise<void>, ...needs: unknown[]): void => {
    if (options.skip?.includes(id) || (needs.length > 0 && needs[0] === undefined)) return;
    // Vitest reads which fixtures a test uses from how it destructures its context: name them all.
    test(`${title} [${id}]`, ({
      channelstack,
      slack,
      github,
      linear,
      notion,
      resend,
      google,
      task,
      expect,
      skip,
      signal,
      onTestFailed,
      onTestFinished,
      annotate,
    }) =>
      run({
        channelstack,
        slack,
        github,
        linear,
        notion,
        resend,
        google,
        task,
        expect,
        skip,
        signal,
        onTestFailed,
        onTestFinished,
        annotate,
      } as TestContext));
  };
};

/**
 * Registers: replies once to a DM · once to a mention · replies in the thread · survives Slack's
 * 3 s retry · handles redelivery idempotently · ignores other bots' messages · rejects a bad
 * signature · acks within 3 s · handles `msg_too_long` · a stream starts and stops · honours
 * Stop · refuses clicks from people who may not act · a double click acts once.
 */
export function slackChecks(options: ChecksOptions): void {
  const { app } = options;
  const prompt = options.prompt ?? `@${app} hello`;
  const wait = options.timeout === undefined ? {} : { timeout: options.timeout };
  const check = registrar(options, SLACK_CHECKS);
  const turns = options.loopTurns ?? 3;
  /** The app under test: the built-in one, or the app of that name (decision 0027), whose agent runs as it. */
  const agentOf = async (slack: SlackFixture): Promise<SlackApp> =>
    app === slack.app.name ? slack.app : slack.createApp({ name: app });
  /** The delivery a message caused to the app under test. */
  const slackDelivery = async (msg: SlackMessage, agent: SlackApp, context: TestContext) =>
    agent.name === context.slack.app.name
      ? deliveryOf(msg, context, "Slack")
      : ((await msg.deliveryFor(agent)) ?? context.skip(`${agent.name} wasn't sent this message`));

  describe(`slack checks: ${app}`, () => {
    check("slack.dm-once", "replies once to a DM", async ({ slack }) => {
      const agent = await agentOf(slack);
      const ana = await slack.createUser({ name: "Ana" });
      const msg = await ana.say(prompt, { to: agent });
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.mention-once", "replies once to a mention", async ({ slack }) => {
      const agent = await agentOf(slack);
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, agent] });
      const msg = await ana.say(prompt, { channel });
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.in-thread", "replies in the thread, not in the channel", async ({ slack }) => {
      const agent = await agentOf(slack);
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, agent] });
      const msg = await ana.say(prompt, { channel });
      await expect(msg.thread).toHaveReplyFrom(app, wait);
      await expect(channel).not.toHaveChannelMessageFrom(app, wait);
    });

    check("slack.retry", "survives Slack's retry after 3 seconds", async (context) => {
      const { slack } = context;
      const agent = await agentOf(slack);
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, agent] });
      const msg = await ana.say(prompt, { channel });
      // Slack retries what it thinks wasn't acknowledged in time, and says so in the retry headers.
      await (await slackDelivery(msg, agent, context)).retry({ after: "3s", reason: "http_timeout" });
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.redelivery", "handles the same event delivered twice", async (context) => {
      const { slack } = context;
      const agent = await agentOf(slack);
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, agent] });
      const msg = await ana.say(prompt, { channel });
      const delivery = await slackDelivery(msg, agent, context);
      await expect(msg.thread).toHaveReplyFrom(app, wait);
      // The same event again, with nothing that marks it as a retry: only its event_id tells.
      await delivery.resend();
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.ignores-bots", "ignores what other bots write", async ({ slack }) => {
      const agent = await agentOf(slack);
      const bot = await slack.createUser({ name: "Deploy Bot", bot: true });
      const channel = await slack.createChannel({ participants: [bot, agent] });
      const msg = await bot.say(prompt, { channel });
      await expect(msg.thread).not.toHaveReplyFrom(app, wait);
    });

    check(
      "slack.no-reply-loop",
      "stops answering another app that answers everything it says",
      async ({ slack, channelstack }) => {
        const agent = await agentOf(slack);
        const peer = await slack.createApp({ name: app === "loop-peer" ? "loop-peer-2" : "loop-peer" });
        const ana = await slack.createUser({ name: "Ana" });
        const channel = await slack.createChannel({ participants: [ana, agent, peer] });
        const msg = await ana.say(prompt, { channel });
        // The peer answers every reply of the agent's, mentioning it, as a second agent without a loop guard would.
        let answered = 0;
        for (let turn = 0; turn <= turns; turn++) {
          await channelstack.quiet(wait);
          const replies = (await msg.thread.replies()).filter((reply) => reply.author.id === agent.id).length;
          if (replies === answered) break;
          answered = replies;
          await peer.reply(`@${agent.name} thanks! Anything else?`, { thread: msg.thread });
        }
        // At most `turns` answers to the peer: the first reply to Ana, then the peer and the agent in turn.
        await expect(msg.thread).toGoQuiet({ maxReplies: 2 * turns + 2, ...within(wait) });
      },
    );

    check("slack.bad-signature", "rejects a delivery with a bad signature", async (context) => {
      const { slack } = context;
      const agent = await agentOf(slack);
      const ana = await slack.createUser({ name: "Ana" });
      const msg = await ana.say(prompt, { to: agent });
      const delivery = await slackDelivery(msg, agent, context);
      const first = await delivery.settled(wait);
      // Over Socket Mode there is no signature to check: the connection is the app's own.
      if (first.attempts[0]?.transport !== "http") return;
      await delivery.resend({ badSignature: true });
      await expect(delivery).toBeRejected(wait);
    });

    check("slack.ack", "acknowledges within 3 seconds", async (context) => {
      const { slack } = context;
      const agent = await agentOf(slack);
      const ana = await slack.createUser({ name: "Ana" });
      const msg = await ana.say(prompt, { to: agent });
      await expect(await slackDelivery(msg, agent, context)).toBeAccepted({ within: "3s", ...wait });
    });

    check("slack.msg-too-long", "still answers when Slack refuses its message as too long", async ({ slack }) => {
      const agent = await agentOf(slack);
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, agent] });
      // Slack refuses the agent's next message once; an agent that handles it says something shorter.
      await using _fault = await slack.fault({
        type: "error",
        operation: "chat.postMessage",
        error: "msg_too_long",
        times: 1,
      });
      const msg = await ana.say(prompt, { channel });
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check(
      "slack.stream-stop",
      "a stream it starts, it also stops",
      async ({ slack }) => {
        const agent = await agentOf(slack);
        const ana = await slack.createUser({ name: "Ana" });
        const msg = await ana.say(options.streamPrompt ?? "", { to: agent });
        await expect(msg.thread).toHaveStreamingReplyFrom(app, wait);
        const reply = await msg.thread.latestReply({ from: app, ...wait });
        const stream = await reply.stream?.ended(wait);
        expect(stream?.state).toBe("completed");
        await expect(msg.thread).toHaveStatus("idle", wait);
      },
      options.streamPrompt,
    );

    check(
      "slack.stop",
      "honours Stop: nothing more is written after it",
      async ({ slack }) => {
        const agent = await agentOf(slack);
        const ana = await slack.createUser({ name: "Ana" });
        const msg = await ana.say(options.streamPrompt ?? "", { to: agent });
        await expect(msg.thread).toHaveStreamingReplyFrom(app, wait);
        await ana.stop({ thread: msg });
        await expect(msg.thread).toHaveStatus("stopped", wait);
        await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
      },
      options.streamPrompt,
    );

    check(
      "slack.click-unauthorized",
      "refuses a click from someone who may not act",
      async ({ slack }) => {
        const agent = await agentOf(slack);
        const approval = options.approval ?? { prompt: "", button: "" };
        const ana = await slack.createUser({ name: "Ana" });
        const channel = await slack.createChannel({ participants: [ana, agent] });
        const msg = await ana.say(approval.prompt, { channel });
        await ana.click(approval.button, { thread: msg.thread });
        // The ask is the only thing everyone sees: whatever the agent tells Ana, it tells her alone.
        await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
      },
      options.approval,
    );

    check(
      "slack.double-click",
      "a double click acts once",
      async ({ slack }) => {
        const agent = await agentOf(slack);
        const approval = options.approval ?? { prompt: "", button: "" };
        const ana = await slack.createUser({ name: "Ana" });
        const admin = await slack.createUser({ name: "Ben", admin: true });
        const channel = await slack.createChannel({ participants: [ana, admin, agent] });
        const msg = await ana.say(approval.prompt, { channel });
        const ask = await msg.thread.waitForReply({ from: app, ...wait });
        // Both presses are on their way before the agent can answer the first. An agent that takes the
        // button away once it has acted leaves nothing for the later press to find, and that is fine.
        const press = () =>
          admin.click(approval.button, { message: ask }).then(
            () => true,
            (error: unknown) => {
              if ((error as { code?: string }).code !== "not_found") throw error;
              return false;
            },
          );
        const pressed = await Promise.all([press(), press()]);
        expect(pressed, "the button was there to press at least once").toContain(true);
        // The approval shows up first; then the thread holds the ask and one message for the one approval.
        await msg.thread.waitForReply({ from: app, ...wait });
        await expect(msg.thread).toHaveRepliesFrom(app, { count: 2, ...wait });
      },
      options.approval,
    );
  });
}

/**
 * Registers: ignores its own comments · one comment per trigger · review-thread replies trigger
 * it · redelivery doesn't duplicate · check runs reach a conclusion · rejects a bad webhook
 * signature.
 */
export function githubChecks(options: ChecksOptions): void {
  const { app } = options;
  const prompt = options.prompt ?? `@${app} hello`;
  const wait = options.timeout === undefined ? {} : { timeout: options.timeout };
  const check = registrar(options, GITHUB_CHECKS);
  const turns = options.loopTurns ?? 3;
  /** The App under test: the built-in one, or the App of that name (decision 0027). */
  const agentOf = async (github: GitHubFixture): Promise<GitHubApp> =>
    app === github.app.name ? github.app : github.createApp({ name: app });
  /** A repository the App is installed on, with Ana as a collaborator and an issue to talk in. */
  const setup = async ({ github }: TestContext, also: readonly GitHubApp[] = []) => {
    const agent = await agentOf(github);
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ collaborators: [ana], apps: [agent, ...also] });
    return { ana, agent, repo };
  };
  /** The delivery checks read the built-in App's delivery: another App's has no `delivery` on a comment yet. */
  const githubDelivery = (comment: { readonly delivery?: GitHubDelivery | undefined }, context: TestContext) =>
    app === context.github.app.name
      ? deliveryOf(comment, context, "GitHub")
      : context.skip(`the GitHub delivery checks read the built-in App's delivery, not ${app}'s`);
  const pullRequest = async (context: TestContext) => {
    const { ana, repo } = await setup(context);
    const pr = await ana.openPullRequest(
      { from: "change", title: "Greet people", changes: { "greeting.txt": "hello\n" } },
      { repo },
    );
    return { ana, repo, pr };
  };

  describe(`github checks: ${app}`, () => {
    check("github.ignores-own-comments", "its own comment doesn't set it off again", async (context) => {
      const { ana, repo } = await setup(context);
      const issue = await ana.openIssue({ title: "A question" }, { repo });
      await ana.comment(prompt, { issue });
      await expect(issue).toHaveCommentFrom(app, wait);
      // An agent that answers its own answer keeps going; one that doesn't is quiet with one comment.
      await expect(issue).toHaveCommentsFrom(app, { count: 1, ...wait });
    });

    check("github.one-comment", "one comment per trigger", async (context) => {
      const { ana, repo } = await setup(context);
      const issue = await ana.openIssue({ title: "Two questions" }, { repo });
      await ana.comment(prompt, { issue });
      await issue.waitForComment({ from: app, ...wait });
      await ana.comment(prompt, { issue });
      await issue.waitForComment({ from: app, ...wait });
      await expect(issue).toHaveCommentsFrom(app, { count: 2, ...wait });
    });

    check("github.review-thread", "answers a mention in a thread on the diff, in that thread", async (context) => {
      const { ana, pr } = await pullRequest(context);
      const inline = await ana.reviewComment(prompt, { pr, path: "greeting.txt", line: 1 });
      const replies = await inline.replies();
      expect(replies.map((reply) => reply.author.name)).toEqual([app]);
    });

    check("github.redelivery", "a redelivered webhook doesn't produce a second answer", async (context) => {
      const { ana, repo } = await setup(context);
      const issue = await ana.openIssue({ title: "Delivered twice" }, { repo });
      const comment = await ana.comment(prompt, { issue });
      const delivery = githubDelivery(comment, context);
      await expect(issue).toHaveCommentFrom(app, wait);
      // GitHub redelivers with the same `X-GitHub-Delivery`, from its UI and its API.
      await delivery.redeliver();
      await expect(issue).toHaveCommentsFrom(app, { count: 1, ...wait });
    });

    check("github.check-run", "every check run it starts reaches a conclusion", async (context) => {
      const { pr } = await pullRequest(context);
      // Quiet means nothing is left open; a check run that never completes is, and the wait says so.
      await context.channelstack.quiet(wait);
      const runs = await pr.checkRuns();
      expect(runs.filter((run) => run.status !== "completed").map((run) => run.name)).toEqual([]);
    });

    check("github.bad-signature", "rejects a webhook with a bad signature", async (context) => {
      const { ana, repo } = await setup(context);
      const issue = await ana.openIssue({ title: "Signed by someone else" }, { repo });
      const delivery = githubDelivery(await ana.comment(prompt, { issue }), context);
      await delivery.resend({ badSignature: true });
      await expect(delivery).toBeRejected(wait);
    });

    check(
      "github.no-reply-loop",
      "stops answering another App that mentions it after every answer",
      async (context) => {
        const peer = await context.github.createApp({ name: app === "loop-peer" ? "loop-peer-2" : "loop-peer" });
        const { ana, agent, repo } = await setup(context, [peer]);
        const issue = await ana.openIssue({ title: "A question" }, { repo });
        await ana.comment(prompt, { issue });
        await expect(issue).toHaveCommentFrom(agent, wait);
        const agentComments = async () => (await issue.comments()).filter((one) => one.author.id === agent.id).length;
        // The peer answers each comment of the agent's, mentioning it, as a second agent without a loop guard would.
        const before = await agentComments();
        let seen = before;
        for (let turn = 0; turn <= turns; turn++) {
          await peer.comment(`@${agent.name} thanks! Anything else?`, { issue });
          await context.channelstack.quiet(wait);
          const now = await agentComments();
          if (now === seen) break;
          seen = now;
        }
        expect(seen - before, "times it answered the other App").toBeLessThanOrEqual(turns);
      },
    );
  });
}

/**
 * The Linear checks: an agent delegated an issue. `prompt` is the issue's title (default "Look
 * into this"); the agent should take the issue, work on it and end its turn.
 */
export function linearChecks(options: ChecksOptions): void {
  const { app } = options;
  const title = options.prompt ?? "Look into this";
  const wait = options.timeout === undefined ? {} : { timeout: options.timeout };
  const check = registrar(options, LINEAR_CHECKS);
  const turns = options.loopTurns ?? 3;
  /** The app under test: the built-in one, or the app of that name (decision 0027). A session's delivery is its own. */
  const agentOf = async (linear: LinearFixture): Promise<LinearApp> =>
    app === linear.app.name ? linear.app : linear.createApp({ name: app });
  /** Ana in a team, an issue, and a session from delegating it to the app. */
  const delegated = async ({ linear }: TestContext) => {
    const agent = await agentOf(linear);
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title }, { team });
    const session = await ana.delegate(agent, { issue });
    return { ana, agent, issue, session };
  };
  const ended = ["complete", "awaitingInput", "error"] as const;

  describe(`linear checks: ${app}`, () => {
    check("linear.first-activity", "acknowledges a new session within 10 seconds", async (context) => {
      const { session } = await delegated(context);
      // Linear shows a session as unresponsive when nothing arrives in that time.
      await expect(session).toHaveActivity({}, { timeout: "10s" });
    });

    check("linear.ends-turn", "ends its turn: the session doesn't stay active", async (context) => {
      const { session } = await delegated(context);
      await session.waitForState([...ended], wait);
    });

    check("linear.stop", "Stop ends the session", async (context) => {
      const { ana, session } = await delegated(context);
      await expect(session).toHaveActivity({}, wait);
      await ana.stop({ session });
      // The agent answers Stop with a response or an error; until then the session is stopping.
      await session.waitForState(["complete", "error"], wait);
    });

    check("linear.redelivery", "a redelivered webhook doesn't start the work again", async (context) => {
      const { session } = await delegated(context);
      const delivery = deliveryOf(session, context, "Linear");
      await session.waitForState([...ended], wait);
      await delivery.redeliver();
      await context.channelstack.quiet(wait);
      const responses = (await session.activities()).filter((activity) => activity.type === "response");
      expect(responses.length).toBeLessThanOrEqual(1);
    });

    check("linear.stale", "rejects a webhook whose timestamp is more than a minute old", async (context) => {
      const { session } = await delegated(context);
      const delivery = deliveryOf(session, context, "Linear");
      await delivery.resend({ stale: true });
      await expect(delivery).toBeRejected(wait);
    });

    check("linear.bad-signature", "rejects a webhook with a bad signature", async (context) => {
      const { session } = await delegated(context);
      const delivery = deliveryOf(session, context, "Linear");
      await delivery.resend({ badSignature: true });
      await expect(delivery).toBeRejected(wait);
    });

    check("linear.no-reply-loop", "stops answering another app that comments on everything", async (context) => {
      const { agent, issue, session } = await delegated(context);
      const peer = await context.linear.createApp({ name: app === "loop-peer" ? "loop-peer-2" : "loop-peer" });
      await session.waitForState([...ended], wait);
      const agentComments = async () => (await issue.comments()).filter((one) => one.author.id === agent.id).length;
      // The peer comments after each comment of the agent's, as a second agent without a loop guard would.
      const before = await agentComments();
      let seen = before;
      for (let turn = 0; turn <= turns; turn++) {
        await peer.comment("Thanks! Anything else?", { issue });
        await context.channelstack.quiet(wait);
        const now = await agentComments();
        if (now === seen) break;
        seen = now;
      }
      expect(seen - before, "times it answered the other app").toBeLessThanOrEqual(turns);
    });
  });
}

/**
 * The Notion checks: an integration mentioned in a page comment. `prompt` is the comment (default
 * `@<app> hello`); the agent should answer once, in that discussion.
 */
export function notionChecks(options: ChecksOptions): void {
  const { app } = options;
  const prompt = options.prompt ?? `@${app} hello`;
  const wait = options.timeout === undefined ? {} : { timeout: options.timeout };
  const check = registrar(options, NOTION_CHECKS);
  const turns = options.loopTurns ?? 3;
  /** The integration under test: the built-in one, or the integration of that name (decision 0027). */
  const agentOf = async (notion: NotionFixture): Promise<NotionIntegration> =>
    app === notion.app.name ? notion.app : notion.createApp({ name: app });
  /** Ana, and her comment on a page the integration is connected to. */
  const commented = async ({ notion }: TestContext, also: readonly NotionIntegration[] = []) => {
    const agent = await agentOf(notion);
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({
      title: "Notes",
      content: "- a first note",
      connections: [agent, ...also],
    });
    const comment = await ana.comment(prompt, { page });
    return { ana, agent, page, comment };
  };
  /** The delivery checks read the built-in integration's delivery: another's has no `delivery` on a comment yet. */
  const notionDelivery = (comment: { readonly delivery?: NotionDelivery | undefined }, context: TestContext) =>
    app === context.notion.app.name
      ? deliveryOf(comment, context, "Notion")
      : context.skip(`the Notion delivery checks read the built-in integration's delivery, not ${app}'s`);

  describe(`notion checks: ${app}`, () => {
    check("notion.reply-in-discussion", "answers a comment in its discussion", async (context) => {
      const { page, comment } = await commented(context);
      await expect(comment.discussion).toHaveCommentFrom(app, wait);
      // An answer in a discussion of its own is one the person doesn't see where they asked.
      const elsewhere = (await page.discussions()).filter((discussion) => discussion.id !== comment.discussion.id);
      expect(elsewhere).toEqual([]);
    });

    check("notion.ignores-own-comments", "its own comment doesn't set it off again", async (context) => {
      const { comment } = await commented(context);
      await expect(comment.discussion).toHaveCommentFrom(app, wait);
      await expect(comment.discussion).toHaveCommentsFrom(app, { count: 1, ...wait });
    });

    check("notion.redelivery", "a webhook sent again doesn't produce a second answer", async (context) => {
      const { comment } = await commented(context);
      const delivery = notionDelivery(comment, context);
      await expect(comment.discussion).toHaveCommentFrom(app, wait);
      // Notion retries with the same event id.
      await delivery.redeliver();
      await expect(comment.discussion).toHaveCommentsFrom(app, { count: 1, ...wait });
    });

    check("notion.bad-signature", "rejects a webhook with a bad signature", async (context) => {
      const delivery = notionDelivery((await commented(context)).comment, context);
      await delivery.resend({ badSignature: true });
      await expect(delivery).toBeRejected(wait);
    });

    check("notion.no-reply-loop", "stops answering another integration that answers everything", async (context) => {
      const peer = await context.notion.createApp({ name: app === "loop-peer" ? "loop-peer-2" : "loop-peer" });
      const { agent, comment } = await commented(context, [peer]);
      await expect(comment.discussion).toHaveCommentFrom(agent, wait);
      const agentComments = async () =>
        (await comment.discussion.comments()).filter((one) => one.author.id === agent.id).length;
      // The peer answers each comment of the agent's in the discussion, as a second agent without a loop guard would.
      const before = await agentComments();
      let seen = before;
      for (let turn = 0; turn <= turns; turn++) {
        await peer.reply("Thanks! Anything else?", { discussion: comment.discussion });
        await context.channelstack.quiet(wait);
        const now = await agentComments();
        if (now === seen) break;
        seen = now;
      }
      expect(seen - before, "times it answered the other integration").toBeLessThanOrEqual(turns);
    });
  });
}

/**
 * The Resend checks: a person emails the agent. `prompt` is the email's text (default `hello`); the
 * agent should answer once, in the email's thread.
 */
export function resendChecks(options: ChecksOptions): void {
  const { app } = options;
  const prompt = options.prompt ?? "hello";
  const wait = options.timeout === undefined ? {} : { timeout: options.timeout };
  const check = registrar(options, RESEND_CHECKS);
  /** Ana, and her email to the agent. */
  const emailed = async ({ resend }: TestContext) => {
    const ana = await resend.createUser({ name: "Ana" });
    const email = await ana.send({ to: [resend.app], subject: "A question", text: prompt });
    return { ana, email };
  };

  describe(`resend checks: ${app}`, () => {
    check("resend.reply-in-thread", "answers an email in its thread", async (context) => {
      const { ana, email } = await emailed(context);
      // The answer reaches Ana, and in the thread she started: In-Reply-To and References are set.
      const answer = await ana.waitForEmail({ from: app, ...wait });
      expect(answer.thread.id, "the answer started a thread of its own: set In-Reply-To and References").toBe(
        email.thread.id,
      );
    });

    check("resend.redelivery", "a webhook sent again doesn't produce a second answer", async (context) => {
      const { email } = await emailed(context);
      const delivery = deliveryOf(email, context, "Resend");
      await expect(email.thread).toHaveReplyFrom(app, wait);
      // Resend retries with the same svix-id and the same email_id.
      await delivery.redeliver();
      await expect(email.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("resend.bad-signature", "rejects a webhook with a bad signature", async (context) => {
      const delivery = deliveryOf((await emailed(context)).email, context, "Resend");
      await delivery.resend({ badSignature: true });
      await expect(delivery).toBeRejected(wait);
    });

    check("resend.stale", "rejects a webhook signed more than five minutes ago", async (context) => {
      const delivery = deliveryOf((await emailed(context)).email, context, "Resend");
      await delivery.resend({ stale: true });
      await expect(delivery).toBeRejected(wait);
    });
  });
}

/**
 * The Google checks: a person emails the agent's Gmail address. `prompt` is the email's text
 * (default `hello`); the agent should answer once, in the email's thread, whatever Gmail pushes.
 */
export function googleChecks(options: ChecksOptions): void {
  const { app } = options;
  const prompt = options.prompt ?? "hello";
  const wait = options.timeout === undefined ? {} : { timeout: options.timeout };
  const check = registrar(options, GOOGLE_CHECKS);
  /** Ana, and her email to the agent. */
  const emailed = async ({ google }: TestContext) => {
    const ana = await google.createUser({ name: "Ana" });
    const email = await ana.send({ to: [google.app], subject: "A question", text: prompt });
    return { ana, email };
  };

  describe(`google checks: ${app}`, () => {
    check("google.reply-in-thread", "answers an email in its thread", async (context) => {
      const { ana, email } = await emailed(context);
      // The answer reaches Ana, and in the thread she started: In-Reply-To and References are set.
      const answer = await ana.waitForEmail({ from: app, ...wait });
      expect(answer.thread.id, "the answer started a thread of its own: set In-Reply-To and References").toBe(
        email.thread.id,
      );
    });

    check("google.history", "answers each of two emails Gmail told of in one push, once", async ({ google }) => {
      // Gmail pushes at most once a second. A first email is pushed at once; the two after it, within
      // that second, wait for its end and come in one push, so the agent must read its history.
      const ana = await google.createUser({ name: "Ana" });
      const opener = await ana.send({ to: [google.app], subject: "Hello", text: prompt });
      const first = await ana.send({ to: [google.app], subject: "First", text: prompt });
      const second = await ana.send({ to: [google.app], subject: "Second", text: prompt });
      await expect(opener.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
      await expect(first.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
      await expect(second.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("google.redelivery", "a push sent again doesn't produce a second answer", async (context) => {
      const { email } = await emailed(context);
      const push = deliveryOf(email, context, "Gmail");
      await expect(email.thread).toHaveReplyFrom(app, wait);
      // Pub/Sub delivers at least once: the same message id again.
      await push.redeliver();
      await expect(email.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("google.bad-signature", "rejects a push whose token another key signed", async (context) => {
      const push = deliveryOf((await emailed(context)).email, context, "Gmail");
      await push.resend({ badSignature: true });
      await expect(push).toBeRejected(wait);
    });

    check("google.wrong-audience", "rejects a push whose token is for another audience", async (context) => {
      const push = deliveryOf((await emailed(context)).email, context, "Gmail");
      await push.resend({ wrongAudience: true });
      await expect(push).toBeRejected(wait);
    });

    check("google.stale", "rejects a push whose token has expired", async (context) => {
      const push = deliveryOf((await emailed(context)).email, context, "Gmail");
      await push.resend({ stale: true });
      await expect(push).toBeRejected(wait);
    });
  });
}
