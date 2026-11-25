import { githubLegacyNodeId, githubNodeId } from "../../core/ids/index.ts";
import type {
  GitHubAppRecord,
  GitHubCheckRunRecord,
  GitHubCommentRecord,
  GitHubCommitInfo,
  GitHubFileChange,
  GitHubIssueRecord,
  GitHubLabelRecord,
  GitHubOrgRecord,
  GitHubReactionRecord,
  GitHubRepoRecord,
  GitHubReviewCommentRecord,
  GitHubReviewRecord,
  GitHubStatusRecord,
  GitHubUserRecord,
} from "./world.ts";
import { type GitHubPermission, PERMISSIONS, REACTIONS } from "./world.ts";

type Json = Record<string, unknown>;

/** GitHub writes times in UTC to the second: `2026-11-21T19:01:12Z`. */
export const githubTime = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const maybeTime = (ms: number | undefined): string | null => (ms === undefined ? null : githubTime(ms));

/** What the builders need to know beyond the record they are given. */
export interface GitHubLookups {
  /** The API root, e.g. `https://github.localhost`. Web pages are served from the same host. */
  url(): string;
  org(): GitHubOrgRecord;
  app(): GitHubAppRecord;
  actor(id: number): GitHubUserRecord;
  repo(id: number): GitHubRepoRecord;
  /** How many comments an issue has, and review comments a pull request. */
  commentCount(issue: GitHubIssueRecord): number;
  reviewCommentCount(issue: GitHubIssueRecord): number;
  openIssueCount(repo: GitHubRepoRecord): number;
  /** Is this person one of the repo's people, for `author_association`? */
  association(repo: GitHubRepoRecord, user: number): string;
}

/** Builders for everything GitHub's REST API answers with and its webhooks carry. One shape, used by both. */
export function githubObjects(lookups: GitHubLookups) {
  const api = () => lookups.url();
  const web = () => lookups.url();

  const user = (record: GitHubUserRecord): Json => {
    const bot = record.type === "Bot";
    const base = `${api()}/users/${encodeURIComponent(record.login)}`;
    return {
      login: record.login,
      id: record.id,
      node_id: githubNodeId(bot ? "Bot" : "User", [record.id]),
      avatar_url: `${web()}/avatars/${bot ? "in" : "u"}/${record.id}?v=4`,
      gravatar_id: "",
      url: base,
      html_url: bot ? `${web()}/apps/${record.login.replace(/\[bot\]$/, "")}` : `${web()}/${record.login}`,
      followers_url: `${base}/followers`,
      following_url: `${base}/following{/other_user}`,
      gists_url: `${base}/gists{/gist_id}`,
      starred_url: `${base}/starred{/owner}{/repo}`,
      subscriptions_url: `${base}/subscriptions`,
      organizations_url: `${base}/orgs`,
      repos_url: `${base}/repos`,
      events_url: `${base}/events{/privacy}`,
      received_events_url: `${base}/received_events`,
      type: record.type,
      user_view_type: "public",
      site_admin: false,
    };
  };
  const actor = (id: number) => user(lookups.actor(id));

  /** The org as the owner of a repository or an installation: a user-shaped object of type Organization. */
  const orgOwner = (): Json => {
    const org = lookups.org();
    return {
      ...user({
        id: org.id,
        login: org.login,
        name: undefined,
        email: undefined,
        type: "User",
        role: "member",
        fixedId: false,
        createdAt: 0,
      }),
      node_id: githubNodeId("Organization", [org.id]),
      type: "Organization",
    };
  };

  /** `GET /users/{username}`: a person's public profile. */
  const publicUser = (record: GitHubUserRecord): Json => ({
    ...user(record),
    name: record.name ?? null,
    company: null,
    blog: "",
    location: null,
    email: record.email ?? null,
    hireable: null,
    bio: null,
    twitter_username: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: githubTime(record.createdAt),
    updated_at: githubTime(record.createdAt),
  });

  /** Someone as a repository's collaborator: the user, with what they may do there. */
  const collaborator = (record: GitHubUserRecord, role: GitHubPermission | "none"): Json => {
    const has = (level: GitHubPermission) => role !== "none" && PERMISSIONS.indexOf(role) >= PERMISSIONS.indexOf(level);
    return {
      ...user(record),
      permissions: {
        admin: has("admin"),
        maintain: has("maintain"),
        push: has("write"),
        triage: has("triage"),
        pull: has("read"),
      },
      role_name: role,
    };
  };

  /** The org as webhooks carry it in `organization`. */
  const organization = (): Json => {
    const org = lookups.org();
    const base = `${api()}/orgs/${org.login}`;
    return {
      login: org.login,
      id: org.id,
      node_id: githubNodeId("Organization", [org.id]),
      url: base,
      repos_url: `${base}/repos`,
      events_url: `${base}/events`,
      hooks_url: `${base}/hooks`,
      issues_url: `${base}/issues`,
      members_url: `${base}/members{/member}`,
      public_members_url: `${base}/public_members{/member}`,
      avatar_url: `${web()}/avatars/u/${org.id}?v=4`,
      description: "",
    };
  };

  const repoApi = (repo: GitHubRepoRecord) => `${api()}/repos/${repo.owner}/${repo.name}`;
  const repoWeb = (repo: GitHubRepoRecord) => `${web()}/${repo.owner}/${repo.name}`;

  const repository = (repo: GitHubRepoRecord): Json => {
    const base = repoApi(repo);
    const html = repoWeb(repo);
    const host = new URL(web()).host;
    const open = lookups.openIssueCount(repo);
    return {
      id: repo.id,
      node_id: githubNodeId("Repository", [repo.id]),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private,
      owner: orgOwner(),
      html_url: html,
      description: null,
      fork: false,
      url: base,
      forks_url: `${base}/forks`,
      keys_url: `${base}/keys{/key_id}`,
      collaborators_url: `${base}/collaborators{/collaborator}`,
      teams_url: `${base}/teams`,
      hooks_url: `${base}/hooks`,
      issue_events_url: `${base}/issues/events{/number}`,
      events_url: `${base}/events`,
      assignees_url: `${base}/assignees{/user}`,
      branches_url: `${base}/branches{/branch}`,
      tags_url: `${base}/tags`,
      blobs_url: `${base}/git/blobs{/sha}`,
      git_tags_url: `${base}/git/tags{/sha}`,
      git_refs_url: `${base}/git/refs{/sha}`,
      trees_url: `${base}/git/trees{/sha}`,
      statuses_url: `${base}/statuses/{sha}`,
      languages_url: `${base}/languages`,
      stargazers_url: `${base}/stargazers`,
      contributors_url: `${base}/contributors`,
      subscribers_url: `${base}/subscribers`,
      subscription_url: `${base}/subscription`,
      commits_url: `${base}/commits{/sha}`,
      git_commits_url: `${base}/git/commits{/sha}`,
      comments_url: `${base}/comments{/number}`,
      issue_comment_url: `${base}/issues/comments{/number}`,
      contents_url: `${base}/contents/{+path}`,
      compare_url: `${base}/compare/{base}...{head}`,
      merges_url: `${base}/merges`,
      archive_url: `${base}/{archive_format}{/ref}`,
      downloads_url: `${base}/downloads`,
      issues_url: `${base}/issues{/number}`,
      pulls_url: `${base}/pulls{/number}`,
      milestones_url: `${base}/milestones{/number}`,
      notifications_url: `${base}/notifications{?since,all,participating}`,
      labels_url: `${base}/labels{/name}`,
      releases_url: `${base}/releases{/id}`,
      deployments_url: `${base}/deployments`,
      created_at: githubTime(repo.createdAt),
      updated_at: githubTime(repo.updatedAt),
      pushed_at: githubTime(repo.pushedAt),
      git_url: `git://${host}/${repo.owner}/${repo.name}.git`,
      ssh_url: `git@${host}:${repo.owner}/${repo.name}.git`,
      clone_url: `${html}.git`,
      svn_url: html,
      homepage: null,
      size: 0,
      stargazers_count: 0,
      watchers_count: 0,
      language: null,
      has_issues: true,
      has_projects: true,
      has_downloads: true,
      has_wiki: false,
      has_pages: false,
      has_discussions: false,
      forks_count: 0,
      mirror_url: null,
      archived: false,
      disabled: false,
      open_issues_count: open,
      license: null,
      allow_forking: true,
      is_template: false,
      web_commit_signoff_required: false,
      topics: [],
      visibility: repo.private ? "private" : "public",
      forks: 0,
      open_issues: open,
      watchers: 0,
      default_branch: repo.defaultBranch,
    };
  };

  /** `GET /repos/{owner}/{repo}`: the repository with what only the full view has. */
  const fullRepository = (repo: GitHubRepoRecord): Json => ({
    ...repository(repo),
    permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    delete_branch_on_merge: false,
    organization: orgOwner(),
    network_count: 0,
    subscribers_count: 0,
  });

  const label = (repo: GitHubRepoRecord, record: GitHubLabelRecord): Json => ({
    id: record.id,
    node_id: githubNodeId("Label", [record.id]),
    url: `${repoApi(repo)}/labels/${encodeURIComponent(record.name)}`,
    name: record.name,
    color: record.color,
    default: false,
    description: record.description,
    archived_at: null,
    archived_by: null,
  });
  const labels = (repo: GitHubRepoRecord, names: readonly string[]): Json[] =>
    names.flatMap((name) => {
      const record = repo.labels.get(name.toLowerCase());
      return record ? [label(repo, record)] : [];
    });

  const reactionRollup = (url: string, reactions: readonly GitHubReactionRecord[]): Json => ({
    url: `${url}/reactions`,
    total_count: reactions.length,
    ...Object.fromEntries(REACTIONS.map((content) => [content, reactions.filter((r) => r.content === content).length])),
  });

  const reaction = (record: GitHubReactionRecord): Json => ({
    id: record.id,
    node_id: githubNodeId("Reaction", [record.id]),
    user: actor(record.user),
    content: record.content,
    created_at: githubTime(record.createdAt),
  });

  const issueApi = (repo: GitHubRepoRecord, number: number) => `${repoApi(repo)}/issues/${number}`;
  const pullApi = (repo: GitHubRepoRecord, number: number) => `${repoApi(repo)}/pulls/${number}`;
  const issueWeb = (repo: GitHubRepoRecord, record: GitHubIssueRecord) =>
    `${repoWeb(repo)}/${record.pull ? "pull" : "issues"}/${record.number}`;

  /** An issue. A pull request shows up as one too, with a `pull_request` pointer. */
  const issue = (record: GitHubIssueRecord): Json => {
    const repo = lookups.repo(record.repo);
    const base = issueApi(repo, record.number);
    const assignees = record.assignees.map(actor);
    return {
      url: base,
      repository_url: repoApi(repo),
      labels_url: `${base}/labels{/name}`,
      comments_url: `${base}/comments`,
      events_url: `${base}/events`,
      html_url: issueWeb(repo, record),
      id: record.id,
      node_id: githubNodeId(record.pull ? "PullRequest" : "Issue", [repo.id, record.pull?.id ?? record.id]),
      number: record.number,
      title: record.title,
      user: actor(record.author),
      labels: labels(repo, record.labels),
      state: record.state,
      locked: false,
      assignee: assignees[0] ?? null,
      assignees,
      milestone: null,
      comments: lookups.commentCount(record),
      created_at: githubTime(record.createdAt),
      updated_at: githubTime(record.updatedAt),
      closed_at: maybeTime(record.closedAt),
      author_association: lookups.association(repo, record.author),
      active_lock_reason: null,
      ...(record.pull
        ? {
            draft: record.pull.draft,
            pull_request: {
              url: pullApi(repo, record.number),
              html_url: issueWeb(repo, record),
              diff_url: `${issueWeb(repo, record)}.diff`,
              patch_url: `${issueWeb(repo, record)}.patch`,
              merged_at: maybeTime(record.pull.mergedAt),
            },
          }
        : {}),
      body: record.body,
      reactions: reactionRollup(base, record.reactions),
      timeline_url: `${base}/timeline`,
      performed_via_github_app: null,
      state_reason: record.stateReason,
    };
  };

  /** One side of a pull request: a branch of the repository and where it points. */
  const side = (repo: GitHubRepoRecord, branch: string, sha: string): Json => ({
    label: `${repo.owner}:${branch}`,
    ref: branch,
    sha,
    user: orgOwner(),
    repo: repository(repo),
  });

  const pullRequest = (record: GitHubIssueRecord): Json => {
    const pull = record.pull;
    if (!pull) throw new Error(`Issue #${record.number} is not a pull request`);
    const repo = lookups.repo(record.repo);
    const base = pullApi(repo, record.number);
    const html = issueWeb(repo, record);
    const issueUrl = issueApi(repo, record.number);
    const assignees = record.assignees.map(actor);
    const open = record.state === "open";
    return {
      url: base,
      id: pull.id,
      node_id: githubNodeId("PullRequest", [repo.id, pull.id]),
      html_url: html,
      diff_url: `${html}.diff`,
      patch_url: `${html}.patch`,
      issue_url: issueUrl,
      number: record.number,
      state: record.state,
      locked: false,
      title: record.title,
      user: actor(record.author),
      body: record.body,
      created_at: githubTime(record.createdAt),
      updated_at: githubTime(record.updatedAt),
      closed_at: maybeTime(record.closedAt),
      merged_at: maybeTime(pull.mergedAt),
      merge_commit_sha: pull.mergeCommitSha ?? null,
      assignee: assignees[0] ?? null,
      assignees,
      requested_reviewers: pull.requestedReviewers.map(actor),
      requested_teams: [],
      labels: labels(repo, record.labels),
      milestone: null,
      draft: pull.draft,
      commits_url: `${base}/commits`,
      review_comments_url: `${base}/comments`,
      review_comment_url: `${repoApi(repo)}/pulls/comments{/number}`,
      comments_url: `${issueUrl}/comments`,
      statuses_url: `${repoApi(repo)}/statuses/${pull.headSha}`,
      head: side(repo, pull.head, pull.headSha),
      base: side(repo, pull.base, pull.baseSha),
      _links: {
        self: { href: base },
        html: { href: html },
        issue: { href: issueUrl },
        comments: { href: `${issueUrl}/comments` },
        review_comments: { href: `${base}/comments` },
        review_comment: { href: `${repoApi(repo)}/pulls/comments{/number}` },
        commits: { href: `${base}/commits` },
        statuses: { href: `${repoApi(repo)}/statuses/${pull.headSha}` },
      },
      author_association: lookups.association(repo, record.author),
      auto_merge: null,
      active_lock_reason: null,
      merged: pull.merged,
      // What GitHub computed from the branches (`refreshPull`): `dirty` when they conflict, `unknown` until computed.
      mergeable: open ? (pull.mergeable ?? null) : null,
      rebaseable: open ? (pull.rebaseable ?? null) : null,
      mergeable_state: !open
        ? "unknown"
        : pull.draft
          ? "draft"
          : pull.mergeable === undefined
            ? "unknown"
            : pull.mergeable
              ? "clean"
              : "dirty",
      merged_by: pull.mergedBy === undefined ? null : actor(pull.mergedBy),
      comments: lookups.commentCount(record),
      review_comments: lookups.reviewCommentCount(record),
      maintainer_can_modify: false,
      commits: pull.stats.commits,
      additions: pull.stats.additions,
      deletions: pull.stats.deletions,
      changed_files: pull.stats.changedFiles,
    };
  };

  const comment = (record: GitHubCommentRecord, on: GitHubIssueRecord): Json => {
    const repo = lookups.repo(record.repo);
    const base = `${repoApi(repo)}/issues/comments/${record.id}`;
    return {
      url: base,
      html_url: `${issueWeb(repo, on)}#issuecomment-${record.id}`,
      issue_url: issueApi(repo, record.issue),
      id: record.id,
      node_id: githubNodeId("IssueComment", [repo.id, record.id]),
      user: actor(record.author),
      created_at: githubTime(record.createdAt),
      updated_at: githubTime(record.updatedAt),
      author_association: lookups.association(repo, record.author),
      body: record.body,
      reactions: reactionRollup(base, record.reactions),
      performed_via_github_app: null,
    };
  };

  const review = (record: GitHubReviewRecord, on: GitHubIssueRecord): Json => {
    const repo = lookups.repo(record.repo);
    const html = `${issueWeb(repo, on)}#pullrequestreview-${record.id}`;
    return {
      id: record.id,
      node_id: githubNodeId("PullRequestReview", [repo.id, record.id]),
      user: actor(record.author),
      body: record.body,
      state: record.state,
      html_url: html,
      pull_request_url: pullApi(repo, record.pull),
      author_association: lookups.association(repo, record.author),
      _links: { html: { href: html }, pull_request: { href: pullApi(repo, record.pull) } },
      ...(record.submittedAt === undefined ? {} : { submitted_at: githubTime(record.submittedAt) }),
      commit_id: record.commitSha,
    };
  };

  const reviewComment = (record: GitHubReviewCommentRecord, on: GitHubIssueRecord): Json => {
    const repo = lookups.repo(record.repo);
    const base = `${repoApi(repo)}/pulls/comments/${record.id}`;
    const html = `${issueWeb(repo, on)}#discussion_r${record.id}`;
    return {
      url: base,
      pull_request_review_id: record.review,
      id: record.id,
      node_id: githubNodeId("PullRequestReviewComment", [repo.id, record.id]),
      diff_hunk: record.diffHunk,
      path: record.path,
      commit_id: record.commitSha,
      original_commit_id: record.commitSha,
      user: actor(record.author),
      body: record.body,
      created_at: githubTime(record.createdAt),
      updated_at: githubTime(record.updatedAt),
      html_url: html,
      pull_request_url: pullApi(repo, record.pull),
      author_association: lookups.association(repo, record.author),
      _links: { self: { href: base }, html: { href: html }, pull_request: { href: pullApi(repo, record.pull) } },
      reactions: reactionRollup(base, record.reactions),
      start_line: record.startLine ?? null,
      original_start_line: record.startLine ?? null,
      start_side: record.startLine === undefined ? null : record.side,
      line: record.line,
      original_line: record.line,
      side: record.side,
      ...(record.inReplyTo === undefined ? {} : { in_reply_to_id: record.inReplyTo }),
      original_position: 1,
      position: 1,
      subject_type: "line",
    };
  };

  /** The App, as `GET /app` answers and as check runs name it. */
  const integration = (): Json => {
    const app = lookups.app();
    return {
      id: app.id,
      client_id: app.clientId,
      slug: app.slug,
      node_id: githubNodeId("App", [app.id]),
      owner: orgOwner(),
      name: app.name,
      description: "",
      external_url: `${web()}/apps/${app.slug}`,
      html_url: `${web()}/apps/${app.slug}`,
      created_at: githubTime(app.createdAt),
      updated_at: githubTime(app.createdAt),
      permissions: { metadata: "read", ...app.permissions },
      events: [...app.events],
    };
  };

  const installation = (): Json => {
    const app = lookups.app();
    const org = lookups.org();
    return {
      id: app.installationId,
      client_id: app.clientId,
      account: orgOwner(),
      repository_selection: "selected",
      access_tokens_url: `${api()}/app/installations/${app.installationId}/access_tokens`,
      repositories_url: `${api()}/installation/repositories`,
      html_url: `${web()}/organizations/${org.login}/settings/installations/${app.installationId}`,
      app_id: app.id,
      app_slug: app.slug,
      target_id: org.id,
      target_type: "Organization",
      permissions: { metadata: "read", ...app.permissions },
      events: [...app.events],
      created_at: githubTime(app.createdAt),
      updated_at: githubTime(app.createdAt),
      single_file_name: null,
      has_multiple_single_files: false,
      single_file_paths: [],
      suspended_by: null,
      suspended_at: null,
    };
  };

  /** The installation as every webhook of an App carries it. */
  const installationLite = (): Json => {
    const { installationId } = lookups.app();
    return { id: installationId, node_id: githubLegacyNodeId("IntegrationInstallation", installationId) };
  };

  const suite = (repo: GitHubRepoRecord, id: number, sha: string): Json => ({
    id,
    node_id: githubNodeId("CheckSuite", [repo.id, id]),
    head_branch: null,
    head_sha: sha,
    status: "queued",
    conclusion: null,
    url: `${repoApi(repo)}/check-suites/${id}`,
    before: null,
    after: sha,
    pull_requests: [],
    app: integration(),
    created_at: githubTime(repo.createdAt),
    updated_at: githubTime(repo.updatedAt),
  });

  const checkRun = (record: GitHubCheckRunRecord): Json => {
    const repo = lookups.repo(record.repo);
    const base = `${repoApi(repo)}/check-runs/${record.id}`;
    return {
      id: record.id,
      name: record.name,
      node_id: githubNodeId("CheckRun", [repo.id, record.id]),
      head_sha: record.headSha,
      external_id: record.externalId,
      url: base,
      html_url: `${repoWeb(repo)}/runs/${record.id}`,
      details_url: record.detailsUrl ?? `${web()}/apps/${lookups.app().slug}`,
      status: record.status,
      conclusion: record.conclusion ?? null,
      started_at: githubTime(record.startedAt),
      completed_at: maybeTime(record.completedAt),
      output: {
        title: record.title ?? null,
        summary: record.summary ?? null,
        text: record.text ?? null,
        annotations_count: record.annotations.length,
        annotations_url: `${base}/annotations`,
      },
      check_suite: suite(repo, record.suite, record.headSha),
      app: integration(),
      pull_requests: [],
    };
  };

  const status = (record: GitHubStatusRecord): Json => {
    const repo = lookups.repo(record.repo);
    return {
      url: `${repoApi(repo)}/statuses/${record.sha}`,
      avatar_url: `${web()}/avatars/u/${record.creator}?v=4`,
      id: record.id,
      node_id: githubNodeId("StatusContext", [repo.id, record.id]),
      state: record.state,
      description: record.description,
      target_url: record.targetUrl,
      context: record.context,
      created_at: githubTime(record.createdAt),
      updated_at: githubTime(record.createdAt),
      creator: actor(record.creator),
    };
  };

  const gitPerson = (who: GitHubCommitInfo["author"]): Json => ({
    name: who.name,
    email: who.email,
    date: githubTime(who.date),
  });
  const unverified = { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null };

  /** `GET /repos/{owner}/{repo}/git/commits/{sha}`: the commit as git has it. */
  const gitCommit = (repo: GitHubRepoRecord, info: GitHubCommitInfo): Json => ({
    sha: info.sha,
    node_id: githubNodeId("Commit", [repo.id, info.sha]),
    url: `${repoApi(repo)}/git/commits/${info.sha}`,
    html_url: `${repoWeb(repo)}/commit/${info.sha}`,
    author: gitPerson(info.author),
    committer: gitPerson(info.committer),
    tree: { sha: info.tree, url: `${repoApi(repo)}/git/trees/${info.tree}` },
    message: info.message,
    parents: info.parents.map((sha) => ({
      sha,
      url: `${repoApi(repo)}/git/commits/${sha}`,
      html_url: `${repoWeb(repo)}/commit/${sha}`,
    })),
    verification: unverified,
  });

  const file = (repo: GitHubRepoRecord, sha: string, change: GitHubFileChange): Json => ({
    sha: change.sha,
    filename: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
    blob_url: `${repoWeb(repo)}/blob/${sha}/${change.path}`,
    raw_url: `${repoWeb(repo)}/raw/${sha}/${change.path}`,
    contents_url: `${repoApi(repo)}/contents/${change.path}?ref=${sha}`,
    ...(change.patch === undefined ? {} : { patch: change.patch }),
  });

  /** `GET /repos/{owner}/{repo}/commits/{ref}`: the commit with who it is attributed to on GitHub. */
  const commit = (
    repo: GitHubRepoRecord,
    info: GitHubCommitInfo,
    people: { author: GitHubUserRecord | undefined; committer: GitHubUserRecord | undefined },
    changes?: readonly GitHubFileChange[],
  ): Json => ({
    sha: info.sha,
    node_id: githubNodeId("Commit", [repo.id, info.sha]),
    commit: {
      author: gitPerson(info.author),
      committer: gitPerson(info.committer),
      message: info.message,
      tree: { sha: info.tree, url: `${repoApi(repo)}/git/trees/${info.tree}` },
      url: `${repoApi(repo)}/git/commits/${info.sha}`,
      comment_count: 0,
      verification: unverified,
    },
    url: `${repoApi(repo)}/commits/${info.sha}`,
    html_url: `${repoWeb(repo)}/commit/${info.sha}`,
    comments_url: `${repoApi(repo)}/commits/${info.sha}/comments`,
    author: people.author ? user(people.author) : null,
    committer: people.committer ? user(people.committer) : null,
    parents: info.parents.map((sha) => ({
      sha,
      url: `${repoApi(repo)}/commits/${sha}`,
      html_url: `${repoWeb(repo)}/commit/${sha}`,
    })),
    ...(changes
      ? {
          stats: {
            total: changes.reduce((sum, change) => sum + change.additions + change.deletions, 0),
            additions: changes.reduce((sum, change) => sum + change.additions, 0),
            deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
          },
          files: changes.map((change) => file(repo, info.sha, change)),
        }
      : {}),
  });

  /** A commit as a `push` webhook lists it. */
  const pushCommit = (
    repo: GitHubRepoRecord,
    info: GitHubCommitInfo,
    changes: readonly GitHubFileChange[],
    login: string | undefined,
  ): Json => {
    const person = (who: GitHubCommitInfo["author"]) => ({
      name: who.name,
      email: who.email,
      ...(login === undefined ? {} : { username: login }),
    });
    const paths = (status: GitHubFileChange["status"]) =>
      changes.filter((change) => change.status === status).map((change) => change.path);
    return {
      id: info.sha,
      tree_id: info.tree,
      distinct: true,
      message: info.message,
      timestamp: githubTime(info.committer.date),
      url: `${repoWeb(repo)}/commit/${info.sha}`,
      author: person(info.author),
      committer: person(info.committer),
      added: paths("added"),
      removed: paths("removed"),
      modified: paths("modified"),
    };
  };

  return {
    user,
    publicUser,
    collaborator,
    actor,
    orgOwner,
    organization,
    repository,
    fullRepository,
    label,
    reaction,
    issue,
    pullRequest,
    comment,
    review,
    reviewComment,
    integration,
    installation,
    installationLite,
    checkRun,
    status,
    gitCommit,
    commit,
    file,
    pushCommit,
    repoApi,
    repoWeb,
  };
}

export type GitHubObjects = ReturnType<typeof githubObjects>;
