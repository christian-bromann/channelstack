/**
 * What the Linear reference agents do, written once against `LinearClient` so the `@linear/sdk`
 * agent and the Chat SDK agent behave the same. Scripted, so tests can rely on it: a session is
 * acknowledged with a thought, the issue moves into a started state, the agent works for a moment
 * and answers, and the issue goes to review. Some issues ask for more: a question first, a plan
 * and a pull request link, a long job that only Stop ends.
 */
import type { LinearClient } from "@linear/sdk";

/** How long the agent "works" between its first thought and its answer. */
const WORK_MS = 1000;
/** How long a job that only Stop ends runs at most. */
const LONG_JOB_MS = 20_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Content =
  | { type: "thought" | "response" | "elicitation" | "error"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

/** How an agent posts its answer: as a `response` activity, or through its framework. */
export type Respond = (sessionId: string, body: string) => Promise<unknown>;

/** What the agent says when it is done with an issue, by what the issue asks for. */
function answerFor(title: string): string {
  if (/\brename/i.test(title)) return "Renamed it everywhere it is read, and updated the example .env.";
  if (/\bmigration\b/i.test(title)) return "Wrote the migration and ran it against a copy of the data.";
  return `Done: ${title}.`;
}

export function linearAgent(linear: LinearClient, respond?: Respond) {
  const publish = (agentSessionId: string, content: Content) => linear.createAgentActivity({ agentSessionId, content });
  const answer: Respond = respond ?? ((sessionId, body) => publish(sessionId, { type: "response", body }));

  /** Sessions already being worked on: a redelivered `created` is the same session, not a new job. */
  const started = new Set<string>();
  /** Jobs that run until Stop, by session: Stop calls the function. */
  const stoppable = new Map<string, () => void>();

  /** Move the issue into the team's first started state, unless it is started or done already. */
  async function startIssue(issueId: string): Promise<void> {
    const issue = await linear.issue(issueId);
    const state = await issue.state;
    if (state && ["started", "completed", "canceled"].includes(state.type)) return;
    const states = (await (await issue.team)?.states())?.nodes ?? [];
    const first = states.filter((candidate) => candidate.type === "started").sort((a, b) => a.position - b.position)[0];
    if (first) await linear.updateIssue(issueId, { stateId: first.id });
  }

  /** Once the work is done, the issue goes to review when the team has such a state. */
  async function toReview(issueId: string): Promise<void> {
    const issue = await linear.issue(issueId);
    const states = (await (await issue.team)?.states())?.nodes ?? [];
    const review = states.find((candidate) => candidate.name === "In Review");
    if (review) await linear.updateIssue(issueId, { stateId: review.id });
  }

  async function work(sessionId: string, issueId: string): Promise<void> {
    const { title } = await linear.issue(issueId);
    await publish(sessionId, { type: "thought", body: `Looking into "${title}"` });
    await startIssue(issueId);

    if (/\blogin bug\b/i.test(title)) {
      await publish(sessionId, { type: "elicitation", body: "Which browsers does it happen in?" });
      return;
    }
    if (/\brefactor\b/i.test(title)) {
      await publish(sessionId, { type: "action", action: "Refactoring", parameter: title });
      const stopped = await new Promise<boolean>((resolve) => {
        stoppable.set(sessionId, () => resolve(true));
        setTimeout(() => resolve(false), LONG_JOB_MS);
      });
      stoppable.delete(sessionId);
      await answer(sessionId, stopped ? "Stopped, as asked. Nothing was changed." : answerFor(title));
      return;
    }
    if (/\brate limit/i.test(title)) {
      await linear.updateAgentSession(sessionId, {
        plan: [
          { content: "Find where requests come in", status: "completed" },
          { content: "Add a limiter per API key", status: "inProgress" },
          { content: "Open a pull request", status: "pending" },
        ],
      });
      await publish(sessionId, { type: "action", action: "Opened a pull request", parameter: "acme/api#42" });
      await linear.updateAgentSession(sessionId, {
        addedExternalUrls: [{ label: "Pull request", url: "https://github.com/acme/api/pull/42" }],
      });
    }

    await pause(WORK_MS);
    await answer(sessionId, answerFor(title));
    await toReview(issueId);
  }

  /** Run a job after the webhook is answered (Linear wants an answer within seconds), reporting a failure in the session. */
  const inBackground = (sessionId: string, job: () => Promise<void>) => {
    job().catch(async (error: unknown) => {
      console.error("The agent failed:", error);
      await publish(sessionId, { type: "error", body: "Something went wrong on my side." }).catch(() => {});
    });
  };

  return {
    /** A session was created: a delegation or a mention. */
    created(sessionId: string, issueId: string): void {
      if (started.has(sessionId)) return;
      started.add(sessionId);
      inBackground(sessionId, () => work(sessionId, issueId));
    },

    /** A person wrote in the session: Stop, or a prompt (an answer to a question, or a follow-up). */
    prompted(sessionId: string, prompt: { body: string; stop: boolean }): void {
      inBackground(sessionId, async () => {
        if (prompt.stop) {
          const stop = stoppable.get(sessionId);
          if (stop) return stop();
          await answer(sessionId, "Stopped, as asked.");
          return;
        }
        await publish(sessionId, { type: "thought", body: "Reading your message" });
        await pause(WORK_MS / 2);
        await answer(sessionId, `Got it: ${prompt.body}. Done.`);
      });
    },
  };
}
