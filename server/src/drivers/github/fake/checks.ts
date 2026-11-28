import { GITHUB_IDS } from "../ids.ts";
import type {
  GitHubAnnotationRecord,
  GitHubAppRecord,
  GitHubCheckConclusion,
  GitHubCheckRunRecord,
  GitHubRepoRecord,
  GitHubStatusRecord,
} from "../world.ts";
import { type GitHubKit, GitHubRefusal } from "./kit.ts";

export interface GitHubCheckRunInput {
  name?: string | undefined;
  headSha?: string | undefined;
  status?: GitHubCheckRunRecord["status"] | undefined;
  conclusion?: GitHubCheckConclusion | undefined;
  externalId?: string | undefined;
  detailsUrl?: string | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  output?:
    | {
        title?: string | undefined;
        summary?: string | undefined;
        text?: string | undefined;
        annotations?: readonly GitHubAnnotationRecord[] | undefined;
      }
    | undefined;
  actions?: ReadonlyArray<{ label: string; description: string; identifier: string }> | undefined;
}

/** Check runs and commit statuses: the App reports, people re-run and press a check's buttons. */
export function createChecks(kit: GitHubKit) {
  const { context, store, objects } = kit;
  const { ids, clock } = context;

  /**
   * `check_run` about a run. `created` and `completed` go to every App subscribed to it; what a
   * person asks of a run (`rerequested`, `requested_action`) goes to the App that made it alone.
   */
  const event = (run: GitHubCheckRunRecord, sender: number, action: string, extra: object = {}) =>
    kit.emit(
      store.repo(run.repo),
      "check_run",
      sender,
      { action, check_run: objects.checkRun(run), ...extra },
      action === "created" || action === "completed" ? undefined : store.appNamed(run.app),
    );
  /** The bot of the App that made a run: who creates and completes it. */
  const owner = (run: GitHubCheckRunRecord) => store.appNamed(run.app).botId;

  /** Apply what a create or an update says. A conclusion means the run is completed. */
  const apply = (run: GitHubCheckRunRecord, input: GitHubCheckRunInput): void => {
    if (input.name !== undefined) run.name = input.name;
    if (input.externalId !== undefined) run.externalId = input.externalId;
    if (input.detailsUrl !== undefined) run.detailsUrl = input.detailsUrl;
    if (input.startedAt !== undefined) run.startedAt = input.startedAt;
    if (input.status !== undefined) run.status = input.status;
    if (input.conclusion !== undefined) {
      run.conclusion = input.conclusion;
      run.status = "completed";
    }
    if (run.status === "completed") run.completedAt = input.completedAt ?? run.completedAt ?? clock();
    else {
      run.conclusion = undefined;
      run.completedAt = undefined;
    }
    if (input.output) {
      run.title = input.output.title ?? run.title;
      run.summary = input.output.summary ?? run.summary;
      run.text = input.output.text ?? run.text;
      // Annotations add up over updates: GitHub takes 50 at a time and keeps them all.
      run.annotations.push(...(input.output.annotations ?? []));
    }
    if (input.actions) run.actions = input.actions.map((action) => ({ ...action }));
  };

  const validate = (input: GitHubCheckRunInput): void => {
    if (input.status === "completed" && input.conclusion === undefined) {
      throw new GitHubRefusal(422, "Validation Failed", [
        { resource: "CheckRun", code: "missing_field", field: "conclusion" },
      ]);
    }
    if (input.output && (input.output.title === undefined || input.output.summary === undefined)) {
      throw new GitHubRefusal(
        422,
        'Invalid request.\n\nFor \'properties/output\', "title" and "summary" are required.',
      );
    }
    if ((input.actions?.length ?? 0) > 3) {
      throw new GitHubRefusal(422, "Invalid request.\n\nNo more than 3 actions are allowed.");
    }
  };

  /** Each App has its own check suite on a commit: made the first time it is needed. */
  const suiteOf = (repo: GitHubRepoRecord, sha: string, app: GitHubAppRecord): number => {
    const key = `${repo.id}:${sha}:${app.name}`;
    const suite = store.suites.get(key) ?? Number(ids.next(GITHUB_IDS.checkRun));
    store.suites.set(key, suite);
    return suite;
  };

  return {
    /**
     * Code was pushed: GitHub makes a check suite for the head commit for each App installed on the
     * repository with the checks write permission, and sends that App alone `check_suite`
     * `requested`, when it subscribes to `check_suite`.
     */
    requestSuites(
      repo: GitHubRepoRecord,
      sender: number,
      push: { branch: string; before: string | null; after: string; headCommit: Record<string, unknown> },
    ): void {
      for (const app of store.apps.all()) {
        if (!repo.apps.has(app.name) || app.permissions.checks !== "write") continue;
        const suite = suiteOf(repo, push.after, app);
        kit.emit(
          repo,
          "check_suite",
          sender,
          { action: "requested", check_suite: objects.checkSuite(repo, suite, push, app) },
          app,
        );
      }
    },

    /** `POST /repos/{owner}/{repo}/check-runs`, as an App (the built-in one unless given). */
    create(
      repo: GitHubRepoRecord,
      input: GitHubCheckRunInput & { name: string; headSha: string },
      app: GitHubAppRecord = store.app,
    ): GitHubCheckRunRecord {
      validate(input);
      const suite = suiteOf(repo, input.headSha, app);
      const run = store.add(store.checkRuns, store.sessionOf(repo), {
        id: Number(ids.next(GITHUB_IDS.checkRun)),
        app: app.name,
        repo: repo.id,
        suite,
        headSha: input.headSha,
        name: input.name,
        status: "queued",
        conclusion: undefined,
        externalId: "",
        detailsUrl: undefined,
        startedAt: clock(),
        completedAt: undefined,
        title: undefined,
        summary: undefined,
        text: undefined,
        annotations: [],
        actions: [],
      });
      apply(run, input);
      event(run, owner(run), "created");
      if (run.status === "completed") event(run, owner(run), "completed");
      return run;
    },

    update(run: GitHubCheckRunRecord, input: GitHubCheckRunInput): GitHubCheckRunRecord {
      validate(input);
      const was = run.status;
      apply(run, input);
      if (run.status === "completed" && was !== "completed") event(run, owner(run), "completed");
      return run;
    },

    /** A person clicks "Re-run". */
    rerun(run: GitHubCheckRunRecord, actor: number): string | undefined {
      kit.action(store.repo(run.repo), "rerun", { user: actor, checkRun: run.id });
      return event(run, actor, "rerequested");
    },

    /** A person clicks one of the buttons the App put on a check run. */
    requestAction(run: GitHubCheckRunRecord, actor: number, identifier: string): string | undefined {
      const action = run.actions.find((candidate) => candidate.identifier === identifier);
      if (!action) {
        const offered = run.actions.map((candidate) => candidate.identifier);
        throw new GitHubRefusal(
          404,
          `The check run "${run.name}" has no action "${identifier}". Its actions: ${offered.length === 0 ? "none" : offered.join(", ")}`,
        );
      }
      kit.action(store.repo(run.repo), "requestAction", { user: actor, checkRun: run.id, identifier });
      return event(run, actor, "requested_action", { requested_action: { identifier } });
    },

    /** The newest check run of each name for a commit: what GitHub shows, and what its API lists by default. */
    latest(repo: GitHubRepoRecord, sha: string): GitHubCheckRunRecord[] {
      const byName = new Map<string, GitHubCheckRunRecord>();
      // Taken out before it is put in again, so a name that reports again moves to the end.
      for (const run of store.checkRunsOf(repo, sha)) {
        byName.delete(run.name);
        byName.set(run.name, run);
      }
      return [...byName.values()];
    },

    /** The newest status of each context for a commit, newest first: what GitHub shows next to it. */
    latestStatuses(repo: GitHubRepoRecord, sha: string): GitHubStatusRecord[] {
      const byContext = new Map<string, GitHubStatusRecord>();
      for (const status of store.statusesOf(repo, sha)) {
        byContext.delete(status.context);
        byContext.set(status.context, status);
      }
      return [...byContext.values()].reverse();
    },

    createStatus(
      repo: GitHubRepoRecord,
      actor: number,
      sha: string,
      input: {
        state: GitHubStatusRecord["state"];
        context?: string | undefined;
        description?: string | undefined;
        targetUrl?: string | undefined;
      },
    ): GitHubStatusRecord {
      return store.add(store.statuses, store.sessionOf(repo), {
        id: Number(ids.next(GITHUB_IDS.status)),
        repo: repo.id,
        sha,
        context: input.context ?? "default",
        state: input.state,
        description: input.description ?? null,
        targetUrl: input.targetUrl ?? null,
        creator: actor,
        createdAt: clock(),
      });
    },
  };
}

export type GitHubChecks = ReturnType<typeof createChecks>;
