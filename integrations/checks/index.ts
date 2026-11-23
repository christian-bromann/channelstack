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

import type { Duration } from "../../sdks/typescript/client.ts";
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
}

/** The ids of the Slack checks, in the order they are registered. */
export const SLACK_CHECKS = [
  "slack.dm-once",
  "slack.mention-once",
  "slack.in-thread",
  "slack.retry",
  "slack.redelivery",
  "slack.ignores-bots",
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
] as const;

/** The ids of the Linear checks, in the order they are registered. */
export const LINEAR_CHECKS = [
  "linear.first-activity",
  "linear.ends-turn",
  "linear.stop",
  "linear.redelivery",
  "linear.stale",
  "linear.bad-signature",
] as const;

/** The ids of the Notion checks, in the order they are registered. */
export const NOTION_CHECKS = [
  "notion.reply-in-discussion",
  "notion.ignores-own-comments",
  "notion.redelivery",
  "notion.bad-signature",
] as const;

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

  describe(`slack checks: ${app}`, () => {
    check("slack.dm-once", "replies once to a DM", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const msg = await ana.say(prompt, { to: slack.app });
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.mention-once", "replies once to a mention", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });
      const msg = await ana.say(prompt, { channel });
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.in-thread", "replies in the thread, not in the channel", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });
      const msg = await ana.say(prompt, { channel });
      await expect(msg.thread).toHaveReplyFrom(app, wait);
      await expect(channel).not.toHaveChannelMessageFrom(app, wait);
    });

    check("slack.retry", "survives Slack's retry after 3 seconds", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });
      const msg = await ana.say(prompt, { channel });
      // Slack retries what it thinks wasn't acknowledged in time, and says so in the retry headers.
      await msg.delivery?.retry({ after: "3s", reason: "http_timeout" });
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.redelivery", "handles the same event delivered twice", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });
      const msg = await ana.say(prompt, { channel });
      await expect(msg.thread).toHaveReplyFrom(app, wait);
      // The same event again, with nothing that marks it as a retry: only its event_id tells.
      await msg.delivery?.resend();
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.ignores-bots", "ignores what other bots write", async ({ slack }) => {
      const bot = await slack.createUser({ name: "Deploy Bot", bot: true });
      const channel = await slack.createChannel({ participants: [bot, slack.app] });
      const msg = await bot.say(prompt, { channel });
      await expect(msg.thread).not.toHaveReplyFrom(app, wait);
    });

    check("slack.bad-signature", "rejects a delivery with a bad signature", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const msg = await ana.say(prompt, { to: slack.app });
      const delivery = msg.delivery;
      if (!delivery) throw new Error("The message caused no delivery to the agent");
      const first = await delivery.settled(wait);
      // Over Socket Mode there is no signature to check: the connection is the app's own.
      if (first.attempts[0]?.transport !== "http") return;
      await delivery.resend({ badSignature: true });
      await expect(delivery).toBeRejected(wait);
    });

    check("slack.ack", "acknowledges within 3 seconds", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const msg = await ana.say(prompt, { to: slack.app });
      const delivery = msg.delivery;
      if (!delivery) throw new Error("The message caused no delivery to the agent");
      await expect(delivery).toBeAccepted({ within: "3s", ...wait });
    });

    check("slack.msg-too-long", "still answers when Slack refuses its message as too long", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });
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
        const ana = await slack.createUser({ name: "Ana" });
        const msg = await ana.say(options.streamPrompt ?? "", { to: slack.app });
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
        const ana = await slack.createUser({ name: "Ana" });
        const msg = await ana.say(options.streamPrompt ?? "", { to: slack.app });
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
        const approval = options.approval ?? { prompt: "", button: "" };
        const ana = await slack.createUser({ name: "Ana" });
        const channel = await slack.createChannel({ participants: [ana, slack.app] });
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
        const approval = options.approval ?? { prompt: "", button: "" };
        const ana = await slack.createUser({ name: "Ana" });
        const admin = await slack.createUser({ name: "Ben", admin: true });
        const channel = await slack.createChannel({ participants: [ana, admin, slack.app] });
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
  /** A repository the App is installed on, with Ana as a collaborator and an issue to talk in. */
  const setup = async ({ github }: TestContext) => {
    const ana = await github.createUser({ login: "ana" });
    const repo = await github.createRepo({ collaborators: [ana], apps: [github.app] });
    return { ana, repo };
  };
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
      await expect(issue).toHaveCommentFrom(app, wait);
      // GitHub redelivers with the same `X-GitHub-Delivery`, from its UI and its API.
      await comment.delivery?.redeliver();
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
      const comment = await ana.comment(prompt, { issue });
      const delivery = comment.delivery;
      if (!delivery) throw new Error("The comment caused no delivery: is the agent's webhook URL set?");
      await delivery.resend({ badSignature: true });
      await expect(delivery).toBeRejected(wait);
    });
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
  /** Ana in a team, an issue, and a session from delegating it to the app. */
  const delegated = async ({ linear }: TestContext) => {
    const ana = await linear.createUser({ name: "Ana" });
    const team = await linear.createTeam({ members: [ana] });
    const issue = await ana.createIssue({ title }, { team });
    const session = await ana.delegate(linear.app, { issue });
    return { ana, issue, session };
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
      await session.waitForState([...ended], wait);
      await session.delivery.redeliver();
      await context.channelstack.quiet(wait);
      const responses = (await session.activities()).filter((activity) => activity.type === "response");
      expect(responses.length).toBeLessThanOrEqual(1);
    });

    check("linear.stale", "rejects a webhook whose timestamp is more than a minute old", async (context) => {
      const { session } = await delegated(context);
      await session.delivery.resend({ stale: true });
      await expect(session.delivery).toBeRejected(wait);
    });

    check("linear.bad-signature", "rejects a webhook with a bad signature", async (context) => {
      const { session } = await delegated(context);
      await session.delivery.resend({ badSignature: true });
      await expect(session.delivery).toBeRejected(wait);
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
  /** Ana, and her comment on a page the integration is connected to. */
  const commented = async ({ notion }: TestContext) => {
    const ana = await notion.createUser({ name: "Ana" });
    const page = await notion.createPage({ title: "Notes", content: "- a first note", connections: [notion.app] });
    const comment = await ana.comment(prompt, { page });
    return { ana, page, comment };
  };

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
      await expect(comment.discussion).toHaveCommentFrom(app, wait);
      // Notion retries with the same event id.
      await comment.delivery?.redeliver();
      await expect(comment.discussion).toHaveCommentsFrom(app, { count: 1, ...wait });
    });

    check("notion.bad-signature", "rejects a webhook with a bad signature", async (context) => {
      const { comment } = await commented(context);
      const delivery = comment.delivery;
      if (!delivery) throw new Error("The comment caused no delivery: is the agent's webhook URL set?");
      await delivery.resend({ badSignature: true });
      await expect(delivery).toBeRejected(wait);
    });
  });
}
