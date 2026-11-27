import { githubTime } from "../../payloads.ts";
import type {
  GitHubAnnotationRecord,
  GitHubCheckConclusion,
  GitHubCheckRunRecord,
  GitHubStatusRecord,
} from "../../world.ts";
import type { GitHubCheckRunInput } from "../checks.ts";
import { GitHubRefusal } from "../kit.ts";
import { type Call, invalid, type Json, notFound, numberParam, page, type Register, text, time } from "./shared.ts";

const STATUSES: readonly string[] = ["queued", "in_progress", "completed"];
const CONCLUSIONS: readonly string[] = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
];
const STATES: readonly string[] = ["pending", "success", "failure", "error"];

/** Check runs and commit statuses. */
export function registerChecks(register: Register): void {
  const read = ["checks", "read"] as const;
  const write = ["checks", "write"] as const;

  const input = (body: Json): GitHubCheckRunInput => {
    const status = text(body, "status");
    const conclusion = text(body, "conclusion");
    if (status !== undefined && !STATUSES.includes(status)) throw invalid("CheckRun", "status", "invalid");
    if (conclusion !== undefined && !CONCLUSIONS.includes(conclusion))
      throw invalid("CheckRun", "conclusion", "invalid");
    const output = body.output as Json | undefined;
    return {
      name: text(body, "name"),
      headSha: text(body, "head_sha"),
      status: status as GitHubCheckRunRecord["status"] | undefined,
      conclusion: conclusion as GitHubCheckConclusion | undefined,
      externalId: text(body, "external_id"),
      detailsUrl: text(body, "details_url"),
      startedAt: time(body, "started_at", "CheckRun"),
      completedAt: time(body, "completed_at", "CheckRun"),
      output: output
        ? {
            title: text(output, "title"),
            summary: text(output, "summary"),
            text: text(output, "text"),
            annotations: Array.isArray(output.annotations)
              ? (output.annotations as GitHubAnnotationRecord[])
              : undefined,
          }
        : undefined,
      actions: Array.isArray(body.actions) ? (body.actions as GitHubCheckRunInput["actions"]) : undefined,
    };
  };
  const runOf = ({ c, world, repo }: Call): GitHubCheckRunRecord => {
    const run = world.kit.store.checkRunsOf(repo).find((candidate) => candidate.id === numberParam(c, "run"));
    if (!run) throw notFound();
    return run;
  };
  const shaOf = async ({ c, world, repo }: Call): Promise<string> => {
    const sha = await world.kit.git.resolve(world.kit.dir(repo), c.req.param("ref") ?? "");
    if (!sha) throw new GitHubRefusal(422, `No commit found for SHA: ${c.req.param("ref")}`);
    return sha;
  };

  register("post", "/check-runs", write, async (call) => {
    const { c, world, repo, body, app } = call;
    const given = input(body);
    if (given.name === undefined) throw invalid("CheckRun", "name");
    if (given.headSha === undefined) throw invalid("CheckRun", "head_sha");
    if (!(await world.kit.git.readCommit(world.kit.dir(repo), given.headSha))) {
      throw new GitHubRefusal(422, `No commit found for SHA: ${given.headSha}`);
    }
    const run = world.checks.create(repo, { ...given, name: given.name, headSha: given.headSha }, app);
    return c.json(world.kit.objects.checkRun(run), 201);
  });

  register("get", "/check-runs/:run{[0-9]+}", read, (call) =>
    call.c.json(call.world.kit.objects.checkRun(runOf(call))),
  );

  register("patch", "/check-runs/:run{[0-9]+}", write, (call) =>
    call.c.json(call.world.kit.objects.checkRun(call.world.checks.update(runOf(call), input(call.body)))),
  );

  register("get", "/check-runs/:run{[0-9]+}/annotations", read, (call) => {
    const run = runOf(call);
    const blob = `${call.world.kit.objects.repoWeb(call.repo)}/blob/${run.headSha}`;
    return call.c.json(
      page(call.c, run.annotations).map((annotation) => ({
        path: annotation.path,
        start_line: annotation.start_line,
        end_line: annotation.end_line,
        start_column: annotation.start_column ?? null,
        end_column: annotation.end_column ?? null,
        annotation_level: annotation.annotation_level,
        title: annotation.title ?? null,
        message: annotation.message,
        raw_details: annotation.raw_details ?? null,
        blob_href: `${blob}/${annotation.path}`,
      })),
    );
  });

  register("get", "/commits/:ref/check-runs", read, async (call) => {
    const { c, world, repo } = call;
    const sha = await shaOf(call);
    // By default GitHub lists the newest run of each name; `filter=all` lists every one.
    const runs = (
      c.req.query("filter") === "all" ? world.kit.store.checkRunsOf(repo, sha) : world.checks.latest(repo, sha)
    ).filter(
      (run) =>
        (c.req.query("check_name") === undefined || run.name === c.req.query("check_name")) &&
        (c.req.query("status") === undefined || run.status === c.req.query("status")),
    );
    return c.json({
      total_count: runs.length,
      check_runs: page(c, runs).map((run) => world.kit.objects.checkRun(run)),
    });
  });

  // --- Commit statuses ------------------------------------------------------------------------

  register("post", "/statuses/:sha", ["statuses", "write"], async (call) => {
    const { c, world, repo, body, bot } = call;
    const sha = c.req.param("sha") ?? "";
    const state = text(body, "state");
    if (state === undefined || !STATES.includes(state)) throw invalid("Status", "state", "invalid");
    if (!(await world.kit.git.readCommit(world.kit.dir(repo), sha)))
      throw new GitHubRefusal(422, `No commit found for SHA: ${sha}`);
    const status = world.checks.createStatus(repo, bot, sha, {
      state: state as GitHubStatusRecord["state"],
      context: text(body, "context"),
      description: text(body, "description"),
      targetUrl: text(body, "target_url"),
    });
    return c.json(world.kit.objects.status(status), 201);
  });

  register("get", "/commits/:ref/statuses", ["statuses", "read"], async (call) => {
    const statuses = [...call.world.kit.store.statusesOf(call.repo, await shaOf(call))].reverse();
    return call.c.json(page(call.c, statuses).map((status) => call.world.kit.objects.status(status)));
  });

  register("get", "/commits/:ref/status", ["statuses", "read"], async (call) => {
    const { c, world, repo } = call;
    const sha = await shaOf(call);
    const statuses = world.checks.latestStatuses(repo, sha);
    const states = statuses.map((status) => status.state);
    const api = world.kit.objects.repoApi(repo);
    return c.json({
      // Failure wins over pending, pending over success; a commit without statuses is pending.
      state: states.some((state) => state === "failure" || state === "error")
        ? "failure"
        : states.length > 0 && states.every((state) => state === "success")
          ? "success"
          : "pending",
      statuses: statuses.map((status) => {
        const { creator: _creator, ...simple } = world.kit.objects.status(status);
        return { ...simple, required: null };
      }),
      sha,
      total_count: statuses.length,
      repository: world.kit.objects.propertiedRepository(repo),
      commit_url: `${api}/commits/${sha}`,
      url: `${api}/commits/${sha}/status`,
      // The combined status has no time of its own in the fake; GitHub's schema doesn't ask for one.
      ...(statuses[0] ? { updated_at: githubTime(statuses[0].createdAt) } : {}),
    });
  });
}
