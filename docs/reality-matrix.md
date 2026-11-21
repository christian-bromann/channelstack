# channelstack: fake and live, feature by feature

> Draft, 2026-11-20. Every row is a method in `api/*.d.ts`. Checked against the platforms' official API docs on 2026-11-19; sources at the end. Cells still marked **unverified** aren't settled by the docs and need a live spike.

Every feature runs in the fake server (in memory). The question this document answers is whether the same call can also run against a **real** app in a real sandbox workspace, and what that takes.

## Legend

**Fake column**

| Value | Meaning |
|---|---|
| **Yes** | The fake will do it; not built yet |
| **Done** | Built and covered by a test in the phase gate. In the cross-cutting table: for the channels built so far (Slack) |

**Live column**

| Value | Meaning |
|---|---|
| **Yes** | Works live with the credentials listed in "How" |
| **Yes, with proxy / browser** | Works live, but only with that extra piece (below) |
| **Agent's concern** | Live, the platform delivers to the agent directly. channelstack never relays events to an agent; how the agent is reachable (public URL, Socket Mode, a deployed staging agent) is up to the agent |
| **Partial** | Works live with a visible difference, explained in "Notes" |
| **Not yet** | Possible on the real platform, but not in the first release. Live runs report `unsupported_in_live`, like **No** |
| **No** | No way to do it on the real platform. Live runs report `unsupported_in_live` and the framework skips the step, so the test still runs fake on every PR |
| **unverified** | The docs don't settle it. Needs a live spike |

**How it's done live**

| Code | What it is |
|---|---|
| **User token** | The person's own credential: Slack `xoxp`, a GitHub PAT for a machine user, a Linear personal API key, a Notion personal access token |
| **App credentials** | The agent app's own credentials from `channelstack.config.ts`: Slack bot token, GitHub App JWT, Linear OAuth app, Notion integration token |
| **Seeding credentials** | A separate admin token channelstack uses to set up places (channels, repos, teams, pages), so setup doesn't look like the agent acting |
| **Browser** | A browser actor: WebdriverIO BiDi driving the real web UI as a sandbox person. It signs in on its own, with no one at the keyboard (see [Signing in without people](#signing-in-without-people)), and reuses the session between runs. Used only where the platform has no API for a person's action |
| **Proxy** | Proxy mode in pass-through: the agent's calls to the real platform go through channelstack, which records them (and can inject faults). Needed to observe the agent's calls live |
| **Pre-provisioned** | Exists in the sandbox ahead of time, because the platform has no API to create it. `createUser({ name: "Ana" })` maps to the sandbox account by name (`CHANNELSTACK_<CHANNEL>_USER_ANA_TOKEN`) |

**What a developer can provide, and what that turns live**

| Credentials | What runs live |
|---|---|
| App credentials only (e.g. just a bot token) | Acting as the app: posting as the bot, installing it, reading. No person actions, because a bot token never acts as a person |
| Plus a user token per sandbox person | Most of the matrix: say, reply, react, edit, DMs, comments, reviews, delegation, reads |
| Plus unattended sign-in secrets per person | The browser rows, as real UI actions |

**Two rules the fake follows so fake and live don't drift:**
1. **When the real platform refuses something, the fake refuses it too,** with the same error. For example, requesting a review from an app's bot.
2. **When live needs proxy or browser, the fake still runs without them.** Only live runs have the extra requirement.

---

## Cross-cutting (all channels)

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `createUser({ name })` | Done | Partial | Pre-provisioned | No platform lets an API create real people in a test workspace. Slack: SCIM only on Business+/Enterprise, `admin.users.invite` is Enterprise-only and invites rather than creates, and developer sandboxes cap at 8 users. Linear: invites only (`organizationInviteCreate`). GitHub and Notion: no user-creation API. Live tests use a fixed pool of sandbox accounts, so options like `admin` or `guest` must match the account |
| `createUser({ id })` (fixed id) | Done | No | — | Real ids are assigned by the platform. Live tests read the id from the pre-provisioned account instead |
| Isolation per test (fresh places) | Done | Yes | Seeding credentials | Live places get a `channelstack-run-<id>` name and are deleted at the end of the session (cleanup ledger) |
| `delivery.attempts`, `status`, `settled()` | Done | No (GitHub: read-only, see below) | — | Fake-only. Live, the platform delivers to the agent directly and channelstack isn't in the path |
| `toBeAccepted({ within })` | Done | No (GitHub: from the delivery log) | — | Fake-only, except GitHub's delivery log records the agent's response time |
| `delivery.resend({ badSignature, stale })` | Done | No | — | Fake-only |
| `toBeRejected()` | Done | No (GitHub: from the delivery log) | — | Fake-only, except GitHub's delivery log records the agent's status code |
| `calls()`, `waitForCall()`, `toHaveReceivedCall()` | Done | Yes, with proxy | Proxy | In base-URL mode the agent talks straight to the platform, so channelstack sees nothing |
| `fault(...)`: rate limits, latency, errors | Done | Yes, with proxy | Proxy | Injected by the proxy on the way to the real platform. Real rate limits also apply |
| "Agent is quiet" (negative and exact-count matchers) | Done | Partial | Proxy, or polling | With proxy: no call in flight and no open stream. Without proxy: the transcript is unchanged for `quietFor`, which is slower and less exact |
| `transcript()` and all `toContainText…` matchers | Done | Yes | User token or App credentials | Built from the platform's read APIs, using the same renderer as the fake |
| `channelstack reset` | Done | No | — | Live cleanup is per session (cleanup ledger) plus `channelstack sweep`. A real workspace is never wiped |

---

## Slack

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `slack.createChannel({ participants, private })` | Done | Yes | Seeding credentials (`conversations.create`, `conversations.invite`) | Including `slack.app` invites the bot |
| `slack.createChannel({ shared: true })` (Slack Connect) | Yes | No | — | Needs a second organization and manual approval |
| `slack.uninstallApp()` | Done | Partial | App credentials (`apps.uninstall` with the token, `client_id` and `client_secret`) | Revokes every token of the installation. Reinstalling needs the OAuth consent flow in a browser, so it belongs in a dedicated nightly job, not in every run |
| `ana.say(text, { channel })` | Done | Yes | User token (`chat.postMessage` as the user) | The platform sends real `message` and `app_mention` events |
| `ana.say(text, { to: slack.app })` (DM) | Done | Yes | User token (`conversations.open`, then `chat.postMessage`) | Fires `message.im` |
| `ana.say(text, { to: [ben, slack.app] })` (group DM) | Done | Yes | User token | |
| `ana.say({ files })` | Yes | Yes | User token (files upload v2) | |
| `ana.reply(text, { thread })` | Done | Yes | User token (`chat.postMessage` with `thread_ts`) | `alsoSendToChannel` → `reply_broadcast` |
| `ana.edit(text, { message })` | Done | Yes | User token (`chat.update`) | Only the person's own messages, as in Slack |
| `ana.delete({ message })` | Done | Yes | User token (`chat.delete`) | |
| `ana.react` / `unreact` | Done | Yes | User token (`reactions.add` / `remove`) | |
| `ben.click("Approve", { message })` | Yes | Yes, with browser | Browser | Confirmed: `block_actions` is only sent when a real person clicks; there's no API to trigger it |
| `ana.select(option, { menu, message })` | Yes | Yes, with browser | Browser | Same as click |
| `ben.waitForModal()` | Yes | Yes, with proxy or browser | Proxy (sees `views.open`) or Browser (sees the modal) | |
| `modal.submit(values)` / `close()` | Yes | Yes, with browser | Browser | Confirmed: no API sends `view_submission` as a user |
| `ana.shortcut(callbackId, { message })` | Yes | Yes, with browser | Browser | |
| `ana.runCommand("/deploy web", { channel })` | Yes | Yes, with browser | Browser | Confirmed: the official docs only cover receiving commands. `chat.command` exists only in community sources (undocumented, legacy tokens), so channelstack doesn't use it |
| `ana.stop({ thread })` | Yes | Yes, with browser | Browser | Confirmed: Stop is a native client button that sends the app `agent_session_stopped`. It only appears when the app subscribes to that event, and no API presses it. The fake models the follow-up too: `chat.appendStream` returns `stopped_by_user` |
| `ana.openDM(slack.app)` | Done | Yes | User token (`conversations.open`) | |
| `ana.openAgentThread()` | Yes | Yes, with browser | Browser | Confirmed: `assistant_thread_started` fires only when the person opens the assistant container, and no API triggers it |
| `ana.pickPrompt(title, { thread })` | Yes | Partial | Browser, or User token | The browser clicks the suggested prompt. A User-token fallback posts the prompt's text into the thread, which looks the same to the agent but isn't a click |
| `ana.switchContext(channel, { thread })` | Yes | Yes, with browser | Browser | `assistant_thread_context_changed` comes from the client |
| `ana.invite` / `kick` | Done | Yes | User token (`conversations.invite` / `kick`) | Kicking needs the right workspace role |
| `ana.renameChannel` / `archiveChannel` | Yes | Yes | User token | |
| `ana.ephemeral()` | Done | Yes, with proxy or browser | Proxy (sees `chat.postEphemeral`) or Browser | Confirmed: ephemeral messages aren't stored and don't persist across reloads, so no read API returns them. The browser only sees them while the page stays open |
| `channel.messages()`, `thread.replies()`, `waitForReply`, `latestReply` | Done | Yes | User token (`conversations.history` / `replies`) | Polled |
| `message.reactions()` | Done | Yes | User token (`reactions.get`) | |
| `message.stream` (chunks and state) | Done | Partial | Proxy (sees `chat.startStream` / `appendStream` / `stopStream`) | **unverified**: whether history returns partial text during a stream. The docs only say a stream that times out after 10 minutes keeps what was streamed. Without proxy, count on seeing only the final text |
| `thread.status()`, `toHaveStatus`, `toHaveStatusText` | Done | Yes, with proxy or browser | Proxy (sees `assistant.threads.setStatus` and its replacement `agents.sessions.setStatus`) or Browser | Confirmed: only write methods exist, nothing reads the status back. The fake serves both method names |
| `agentThread.suggestedPrompts()` | Yes | Yes, with proxy or browser | Proxy or Browser | Confirmed: no read API |
| `toBeEphemeralFor(user)` | Yes | Yes, with proxy or browser | Same as `ephemeral()` | |
| `toHaveButton(label)` | Done | Yes | User token (the blocks are in history) | |
| `toHaveOpenedModal(title)` | Yes | Yes, with proxy or browser | Same as `waitForModal` | |
| `delivery.retry({ after: "3s" })` | Done | No | — | Fake-only. channelstack doesn't sit between the platform and the agent live |
| Socket Mode delivery | Yes | Agent's concern | — | Live, the agent connects to Slack itself |

---

## GitHub

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `github.createRepo({ files, collaborators, labels })` | Yes | Yes | Seeding credentials (org admin) | Created in the test org, deleted at the end of the session. Collaborator invites are accepted with each user's token |
| `github.createRepo({ apps: [github.app] })` | Yes | Yes | Seeding credentials (`PUT /user/installations/{id}/repositories/{repo}`), or the installation set to "all repositories" | Confirmed: works with a fine-grained PAT that has "GitHub App installation repository access" write permission, or a GitHub App user access token; the user needs admin on the repo. The first install of the App on the org happens once, in a browser |
| `repo.installApp` / `uninstallApp` | Yes | Yes | Same as above; removing the whole installation uses App credentials (`DELETE /app/installations/{id}`) | |
| `ana.push(changes, { repo, branch })` | Yes | Yes | User token (Git Data or Contents API) | Fires real `push` events |
| `ana.openIssue` / `openPullRequest` | Yes | Yes | User token | `openPullRequest({ changes })` pushes the branch first |
| `ana.editIssue`, `close`, `reopen` | Yes | Yes | User token | |
| `ana.label` / `unlabel` | Yes | Yes | User token | |
| `ana.assign([ben], { issue })` | Yes | Yes | User token | |
| `ana.assign(github.app, { issue })` | Refused | No | — | **unverified**, likely refused: the docs don't cover bot assignees, and community reports say it fails. The fake refuses, so tests don't pass fake and fail live; confirm in the first live spike |
| `ana.comment(text, { issue })` | Yes | Yes | User token | `@my-agent` becomes a real mention |
| `ana.edit` / `delete` (comments) | Yes | Yes | User token | |
| `ana.react(content, { issue \| comment })` | Yes | Yes | User token | |
| `ana.minimize({ comment })` | Yes | Yes | User token (GraphQL `minimizeComment`) | |
| `ana.review({ pr, event, comments })` | Yes | Yes | User token | Inline comments become `pull_request_review_comment` |
| `ana.reviewComment(text, { pr, path, line })` | Yes | Yes | User token | |
| `ana.reply(text, { comment })` (review thread) | Yes | Yes | User token | |
| `ana.resolve` / `unresolve` | Yes | Yes | User token (GraphQL `resolveReviewThread`) | |
| `ana.requestReview([ben], { pr })` | Yes | Yes | User token | |
| `ana.requestReview(github.app, { pr })` | Refused | No | — | **unverified**, likely refused: the endpoint takes user logins and team slugs only. The fake refuses too |
| `ana.markReady({ pr })` / `merge({ pr })` | Yes | Yes | User token | |
| `ana.rerun({ checkRun })` | Yes | Not yet | — | Not in the first release. Confirmed: `rerequest` returns 403 unless the caller is the App that owns the check run, so a person's Re-run is a UI click. Live runs report `unsupported_in_live` |
| `ana.requestAction(id, { checkRun })` | Yes | Yes, with browser | Browser | Confirmed: no API; clicking only sends the `check_run.requested_action` webhook |
| `pr.checkRuns()`, `commit.statuses()`, `toHaveCheckRun` | Yes | Yes | User token | |
| `issue.comments()`, `pr.reviews()`, `reviewComments()`, `toHaveCommentsFrom`, `toHaveReviewComment`, `toBeMerged` | Yes | Yes | User token | |
| `repo.readFile(path, { ref })` | Yes | Yes | User token | |
| `delivery.redeliver()` | Yes | Yes | App credentials (`POST /app/hook/deliveries/{id}/attempts`, App JWT) | Confirmed. GitHub redelivers to the agent's own webhook URL |
| `delivery.attempts`, `status` for the agent's webhook | Yes | Yes | App credentials (`GET /app/hook/deliveries`, App JWT) | Read-only: GitHub's delivery log shows each delivery to the agent, its status code and duration. channelstack stays out of the path |

---

## Linear

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `linear.createTeam({ key, members, states, labels })` | Yes | Yes | Seeding credentials (admin API key, `teamCreate`) | Generated keys avoid collisions. Deleted (or archived) at the end of the session |
| `ana.createIssue({ … }, { team })` | Yes | Yes | User token (`issueCreate`) | |
| `ana.createIssue({ delegate: linear.app })` | Yes | Yes | User token (`issueCreate` with `delegateId`) | Confirmed |
| `ana.editIssue`, `assign`, `setState`, `label` | Yes | Yes | User token (`issueUpdate`) | |
| `ana.delegate(linear.app, { issue })` | Yes | Yes | User token (`issueUpdate` with `delegateId`) | Confirmed: changing the delegate can start an agent session |
| `ana.undelegate({ issue })` | Yes | Yes | User token (`issueUpdate` with `delegateId: null`) | Confirmed |
| `ana.comment("@my-agent …", { issue })` | Yes | Yes | User token (`commentCreate`) | Confirmed for people: channelstack writes the profile URL (`https://linear.app/<workspace>/profiles/<user>`) into the Markdown body, and Linear turns it into a mention. **unverified** whether an app's profile URL opens a session the same way |
| `ana.reply` / `edit` / `delete` / `react` (comments) | Yes | Yes | User token | |
| `ana.prompt(text, { session })` | Yes | Yes | User token (`commentCreate` with `parentId` set to the session's root comment) | **unverified**: the docs say a person's new message in a session sends `prompted`, but don't say an API reply counts. First live spike |
| `ana.answer(text, { elicitation })` | Yes | Yes | User token (same as prompt) | |
| `ana.stop({ session })` | Yes | Yes, with browser | Browser | Confirmed: the `stop` signal is only generated when a person presses Stop in Linear, and it can't be published through `agentActivityCreate` |
| `session.state()`, `activities()`, `plan()`, `externalUrls()`, `toHaveSessionState`, `toHaveActivity` | Yes | Yes | User token (GraphQL reads) | |
| `issue.comments()`, `toHaveCommentFrom`, `toBeDelegatedTo`, `toHaveState` | Yes | Yes | User token | |
| `delivery.redeliver()` | Yes | No | — | Fake-only. Linear has no redelivery mutation |
| Webhook deliveries to the agent | Yes | Agent's concern | — | Linear delivers to the agent's own webhook URL |

---

## Notion

Notion now has **personal access tokens** that act as the person who created them, with that person's permissions and no page sharing. That's the "User token" for Notion, and it makes most person actions possible live. The integration's own token (internal or public OAuth) always acts as a bot.

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `notion.createPage({ content, connections })` (seed) | Yes | Yes | Seeding credentials (a seeding PAT), under a parent page the agent's integration is connected to once, by hand | Confirmed: sharing a parent gives access to all child pages, which is how `connections: [notion.app]` works live |
| `notion.createPage({ connections: [] })` (agent not connected) | Yes | Yes | Seeding credentials, under a parent the agent can't see | |
| `notion.createDatabase({ properties, rows })` | Yes | Yes | Seeding credentials | |
| `ana.createPage(...)` (as a person) | Yes | Yes | User token (PAT) | |
| `ana.comment(text, { page, anchor })` | Yes | Yes | User token (PAT) | **unverified**: whether `created_by` on a PAT-made comment is the person or a bot. The docs only confirm that the display name is the person's |
| `ana.reply(text, { discussion })` | Yes | Yes | User token (PAT, comment with `discussion_id`) | |
| `ana.editComment` / `deleteComment` | Yes | Yes | User token (PAT) | Content only |
| `ana.resolve` / `reopen` (discussion) | Yes | Not yet | — | Not in the first release. Confirmed: the REST API has no resolve action, so a person's resolve is a UI click (browser actor later) |
| `ana.edit({ append }, { page })`, `rename`, `setProperty`, `addRow` | Yes | Yes | User token (PAT) | |
| `ana.mention(notion.app, { page })` | Yes | Yes | User token (PAT) | **unverified**: whether an in-body mention of an integration reaches the agent as an event |
| `ana.connect` / `disconnect(notion.app, { page })` | Yes | Yes, with browser | Browser ("Add connections" in the page menu) | Confirmed: no API adds or removes a connection |
| `page.markdown()`, `blocks()`, `property()`, `discussions()`, `toHaveBlock`, `toHaveCommentFrom`, `toHavePropertyValue` | Yes | Yes | User token or seeding credentials (read APIs) | |
| `discussion.resolved()` | Yes | Not yet | — | No resolved field in the REST API. Follows `resolve` |
| Webhook deliveries (`comment.created`, `page.content_updated`) | Yes | Agent's concern | — | Notion delivers to the agent's own URL. The fake signs `X-Notion-Signature: sha256=<HMAC-SHA256 of the body, keyed with the verification token>`, batches `page.content_updated` the way Notion does, and retries like Notion (up to 8 times over about 24 hours) |
| `delivery.resend()` / redelivery | Yes | No | — | Fake-only. Notion has no redelivery API |

---

## What this means for test authors

1. **Most of a test runs live with plain tokens.** Posting, replying, commenting, reviewing, delegating and every read work on all four platforms through a person's token, including Notion, now that it has personal access tokens.
2. **The UI-only actions** are:
   - Slack: clicks, modals, slash commands, Stop and the agent split view.
   - GitHub: the requested-action buttons on check runs. (Re-run is not yet supported live.)
   - Linear: Stop.
   - Notion: adding connections. (Resolving discussions is not yet supported live.)

   They need the browser actor live. It signs in without people (next section).
3. **Live mode acts and observes; it never relays.** channelstack acts on the real platform and reads the results back to check that the agent reacted. The platform delivers events to the agent directly; delivery chaos (retries, bad signatures, redelivery) is fake-only. On GitHub, the App's delivery log still lets tests read what was delivered to the agent ([live-mode.md](live-mode.md)).
4. **Agent-side visibility works live only through proxy.** That covers API calls, the status line, streams, ephemeral messages and faults.
5. **A test can declare what it needs** with `test.requires(["browser"])` or `["proxy"]`. A live run without that piece skips the test and says why, instead of failing. The fake run never skips.

Some things are fake-only: fixed user ids, Slack Connect channels, uninstall and reinstall in every run, and `channelstack reset`. Tests that rely on them still run on every PR. The coverage page lists them as fake-only.

## Signing in without people

The browser actor runs in CI, so nobody signs in by hand. Each sandbox person is created once by the sandbox owner (no platform has an API for that). After that, the browser actor signs in on its own:

| Platform | Unattended sign-in | Secrets in CI |
|---|---|---|
| **GitHub** | Passkey through WebDriver's virtual authenticator, or password plus TOTP. GitHub skips the new-device email check when 2FA or a passkey is used | The passkey's private key (`CHANNELSTACK_GITHUB_USER_ANA_PASSKEY`), or the password and TOTP seed. Use a machine account; GitHub's terms allow one free machine account per person |
| **Linear** | Passkey through the virtual authenticator, or the emailed sign-in code | The passkey's private key, or access to the person's test inbox |
| **Slack** | The emailed sign-in code. Developer sandboxes sign people in with a single-use code sent to their email; custom SAML isn't available there | Access to the test inbox (a mail-testing service or your own domain). Set a long session duration in the sandbox so sign-ins are rare |
| **Notion** | The emailed sign-in code | Access to the test inbox |

- **Sign in rarely.** The session is saved (browser storage state, kept in an encrypted CI secret or a 0600 file) and reused. `channelstack doctor` checks that it still works, and the browser actor signs in again only when it doesn't. Scripted sign-ins from CI addresses are what trigger CAPTCHAs and account flags.
- **`channelstack login <channel> --user ana`** runs the same sign-in once locally, to produce the saved session and, for passkeys, to register the virtual authenticator's key.
- **If a sign-in is challenged** (a CAPTCHA, a new-device prompt), the browser rows are skipped with the reason and the run doesn't fail. channelstack never tries to solve a CAPTCHA.

## Still to confirm in the first live spike

1. **Slack:** does `conversations.replies` show partial text while a message streams?
2. **GitHub:** are App bots refused as assignees and reviewers? The fake already refuses both.
3. **Linear:**
   - Does an API reply (`commentCreate` with `parentId`) in a session send `prompted`?
   - Does an app's profile URL in a comment body open a session?
4. **Notion:**
   - Is `created_by` on a comment made with a PAT the person or a bot?
   - Do comments and edits made by a person's PAT fire the agent integration's webhooks?
   - Does an in-body mention of an integration reach the agent?

5. **Sign-in:** how often do scripted sign-ins from CI get challenged on each platform, and how long does a saved session last with the longest session setting?

## Sources

- **Slack:**
  - [Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction)
  - [Implementing slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands)
  - [chat.postEphemeral](https://docs.slack.dev/reference/methods/chat.postEphemeral)
  - [assistant.threads.setStatus](https://docs.slack.dev/reference/methods/assistant.threads.setStatus)
  - [Agent sessions](https://docs.slack.dev/ai/agent-sessions)
  - [assistant_thread_started](https://docs.slack.dev/reference/events/assistant_thread_started)
  - [agent_session_stopped](https://docs.slack.dev/reference/events/agent_session_stopped)
  - [chat.startStream](https://docs.slack.dev/reference/methods/chat.startStream)
  - [SCIM API](https://docs.slack.dev/admins/scim-api)
  - [Developer sandboxes](https://docs.slack.dev/tools/developer-sandboxes/)
  - [apps.uninstall](https://docs.slack.dev/reference/methods/apps.uninstall)
  - [Manage session duration](https://slack.com/help/articles/115005223763-Manage-session-duration)
- **GitHub:**
  - [Review requests](https://docs.github.com/en/rest/pulls/review-requests)
  - [Check runs](https://docs.github.com/en/rest/checks/runs)
  - [Fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
  - [App webhooks](https://docs.github.com/en/rest/apps/webhooks)
  - [Verifying new devices when signing in](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/verifying-new-devices-when-signing-in)
  - [Terms of Service: machine accounts](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
- **Linear:**
  - [Agents](https://linear.app/developers/agents)
  - [Agent interaction](https://linear.app/developers/agent-interaction)
  - [Agent signals](https://linear.app/developers/agent-signals)
  - [GraphQL schema](https://linear.app/developers/graphql)
  - [Login methods](https://linear.app/docs/login-methods)
- **Notion:**
  - [Personal access tokens](https://developers.notion.com/guides/connections-and-tokens/personal-access-tokens)
  - [Comment display name](https://developers.notion.com/reference/comment-display-name)
  - [Authorization](https://developers.notion.com/docs/authorization)
  - [Update a comment](https://developers.notion.com/reference/update-a-comment)
  - [Webhook events and delivery](https://developers.notion.com/reference/webhooks-events-delivery)
  - [Webhooks](https://developers.notion.com/reference/webhooks)
  - [MCP comment tools](https://developers.notion.com/guides/mcp/tools-comments-reference)
