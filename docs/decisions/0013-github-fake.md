# 0013: The GitHub fake: names, ids, the App and what stays unverified

Status: accepted, phase 3.

## Names and ids in the shared org

There is one fake org (`acme`), and every test is a session in it (decision 0006). GitHub adds a twist: the agent names a repository in every path (`/repos/acme/web/...`), where Slack uses ids.

- **A repository name is one repository in the whole world.** A second session that asks for a name another open session holds is refused with `invalid_argument`, like a fixed id in decision 0006. Without a name, a repository is called `test-<its id>`, so tests that don't care never collide. The name is free again when its session closes.
- **Logins are unique per session, not per org.** Two sessions can each have an `ana`, with different numeric ids. The agent meets a login only inside a repository's payloads, and a repository belongs to one session, so it never sees two. `GET /users/{login}` from the agent's side answers with the newest person of that name.
- **Fixed numeric ids** (`createUser({ id })`) are unique in the world, as in decision 0006.

Alternative: prefix names per session. Rejected: a test that asks for `web` must get `acme/web`, because agents and fixtures compare names.

## The control API addresses a repository by its id

`GET /sessions/{sid}/github/repos/{repo}/issues/{number}/comments`, where `{repo}` is the repository's numeric id, not `{owner}/{repo}`. An issue's handle is `repoId` and `number`.

Why: the id is the platform's own (`Resource.id`), it is one path segment, and a handle that is one value can be a query parameter (`github.deliveries({ resource: repo })`) and a plain reference in a body. docs/architecture.md and docs/implementation-plan.md showed `repos/{owner}/{repo}` as an example; both now show the id. The fake REST API the agent calls is GitHub's own and keeps `/repos/{owner}/{repo}`.

## The App

- **One App, one installation, selected repositories.** The App is installed on the org, and `createRepo({ apps })` or `repo.installApp()` adds a repository to the installation, which sends `installation_repositories`. For the App's token a repository it isn't installed on doesn't exist (404).
- **Authentication as on GitHub.** The App's own endpoints take a JWT signed with its private key (RS256, `iss` the App id or client id, at most ten minutes); everything else takes the installation token from `POST /app/installations/{id}/access_tokens`.
- **The private key is a secret like the others:** an RSA key generated once per install, kept in `secrets.json` (0600), handed to the agent by `channelstack env` as a PEM in one line with `\n` for its line breaks (an `.env` line is one line; Probot and Octokit's App auth take it this way).
- **The App's ids hold over a reset.** The App id, client id, installation id and the bot's user id are drawn once when the fake is created; `POST /reset` builds a new world with the same App in it, so an agent that keeps running still authenticates. Over a restart of the server they are the same only with `CHANNELSTACK_SEED` set (ids come from the seeded source); without it a restart draws new ones, and the agent needs `channelstack env` read again. The secrets hold either way.
- **The installation token is one stable secret,** not a new one per request, so an agent's cached token survives a server restart. GitHub issues a new token on every call; an agent can't tell the difference, and the token still expires on paper after an hour.

## What the fake does that GitHub may not

Recorded here and in the reality matrix, to be settled by the first live run:

- **The App's bot as assignee or reviewer.** The contract takes the app in `assign` and `requestReview`, so the fake accepts it and sends the event. GitHub likely refuses both for an ordinary App.
- **Review comment refusals.** A comment on a line outside the diff is refused with 422; the exact wording of GitHub's messages is recalled, not recorded.
- **A check run created as completed** sends `check_run.created` and then `check_run.completed`.
- **A person's own events.** The App is told about its own comments, commits and check runs, as on GitHub; the standard check `github.ignores-own-comments` exists because of it.

## Held to GitHub's own schemas

Every REST response and every webhook is validated in tests against `@octokit/openapi` (GitHub's REST description) and `@octokit/openapi-webhooks`: once for every route in a unit scenario, and after every acceptance test for whatever the reference agent called. Where GitHub's own answers don't satisfy GitHub's own description, the validator (`server/test/github-schemas.ts`) reads the description the way GitHub answers. Each case is named there, and here:

- `nullable` (OpenAPI 3.0) is translated to JSON Schema, and a nullable reference written as `allOf` plus `type: ["null"]` (in the webhook schemas) is read as "this or null".
- `format: email` accepts GitHub's bot addresses (`…+my-agent[bot]@users.noreply.github.com`).
- An installation's `account` is described as a user and an enterprise at once (`allOf`); it is read as one or the other.
- A 409 from the contents API is described as exactly one of two errors, and a plain error fits both; it is read as either.
- Status codes the description doesn't list for a route, where GitHub answers with its usual error object: 422 from creating a check run or a status, and 404 from the App's delivery log. The validator refuses an exception for a status the description does list.

The App's own endpoints are about no repository and so belong to no session. The core event log keeps such calls in a scope of their own (`WORLD_SCOPE`), redacted and numbered like a session's, for every session to read (`github.appCalls()`). No session's close ends that scope, so it keeps its newest 10,000 events (#16); a reset empties it. Only calls that authenticated as the App or its installation are recorded at all; reading or redelivering one delivery is on the record of that delivery's session. The acceptance run checks the calls made there since each test began.

## Dependencies

`isomorphic-git` on `memfs` for git objects with real SHAs, `diff` for patches, `jose` for the App's JWT. Reasons and versions are in phase-log/phase-3/plan.md.
