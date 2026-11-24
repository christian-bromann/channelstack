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
| **Built** | Works live with the credentials in "How", built and covered by the unit tests against a stand-in for the platform; the nightly live job runs it against the sandbox |
| **Yes** | Works live with the credentials listed in "How"; not built yet. On a driver whose credentials are set, live runs report `unsupported_in_live` and the framework skips the step |
| **Yes, with proxy / browser** | Works live, but only with that extra piece (below). Until the browser actor and proxy mode (phase 6) exist, live runs report `action_requires` and the framework skips the step |
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

**Where the fake is deliberately more lenient than the platform:** a channel name is unique per session, not per workspace, so parallel tests can each have a `#support` ([decision 0006](decisions/0006-shared-world-collisions.md)). Real Slack refuses the second one with `name_taken`; live, places get a run-specific name.

**Two rules the fake follows so fake and live don't drift:**
1. **When the real platform refuses something, the fake refuses it too,** with the same error. For example, requesting a review from an app's bot.
2. **When live needs proxy or browser, the fake still runs without them.** Only live runs have the extra requirement.

---

## Cross-cutting (all channels)

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `createUser({ name })` | Done | Partial | Pre-provisioned | No platform lets an API create real people in a test workspace. Slack: SCIM only on Business+/Enterprise, `admin.users.invite` is Enterprise-only and invites rather than creates, and developer sandboxes cap at 8 users. Linear: invites only (`organizationInviteCreate`). GitHub and Notion: no user-creation API. Live tests use a fixed pool of sandbox accounts, so options like `admin` or `guest` must match the account |
| `createUser({ id })` (fixed id) | Done | No | — | Real ids are assigned by the platform. Live tests read the id from the pre-provisioned account instead |
| Isolation per test (fresh places) | Done | Built (Slack) | A person's token | Live places get a `channelstack-run-<run>-<n>` name and are removed at the end of the session (cleanup ledger): Slack channels are archived (Slack can't delete one outside Enterprise Grid), and what the session wrote in a DM is deleted. `channelstack sweep` removes what a crashed run left ([decision 0015](decisions/0015-live-mode.md)) |
| `delivery.attempts`, `status`, `settled()` | Done | No (GitHub: read-only, see below) | — | Fake-only. Live, the platform delivers to the agent directly and channelstack isn't in the path |
| `toBeAccepted({ within })` | Done | No (GitHub: from the delivery log) | — | Fake-only, except GitHub's delivery log records the agent's response time |
| `delivery.resend({ badSignature, stale })` | Done | No | — | Fake-only |
| `toBeRejected()` | Done | No (GitHub: from the delivery log) | — | Fake-only, except GitHub's delivery log records the agent's status code |
| `calls()`, `waitForCall()`, `toHaveReceivedCall()` | Done | Yes, with proxy | Proxy | In base-URL mode the agent talks straight to the platform, so channelstack sees nothing |
| `fault(...)`: rate limits, latency, errors | Done | Yes, with proxy | Proxy | Injected by the proxy on the way to the real platform. Real rate limits also apply |
| "Agent is quiet" (negative and exact-count matchers) | Done | Yes, with proxy | Proxy | With proxy: no call in flight and no open stream. Live without proxy, nothing tells channelstack when the agent is done: a session that acted live gets `action_requires`, and those matchers skip. Positive matchers poll and work. A fallback (the transcript unchanged for `quietFor`) is possible later |
| `transcript()` and all `toContainText…` matchers | Done | Built (Slack) | User token or App credentials | Built from the platform's read APIs, using the same renderer as the fake |
| `channelstack reset` | Done | No | — | Live cleanup is per session (cleanup ledger) plus `channelstack sweep`. A real workspace is never wiped |

---

## Slack

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `slack.createChannel({ participants, private })` | Done | Built | User token of the first real person in it (`conversations.create`, `conversations.invite`) | Including `slack.app` invites the bot. The app's bot can't create channels, so a person does; no separate seeding token is needed |
| `slack.createChannel({ shared: true })` (Slack Connect) | Yes | No | — | Needs a second organization and manual approval |
| `slack.uninstallApp()` | Done | Not yet | App credentials (`apps.uninstall` with the token, `client_id` and `client_secret`) | Revokes every token of the installation. Reinstalling needs the OAuth consent flow in a browser, so it belongs in a dedicated nightly job, not in every run. Live runs report `unsupported_in_live` until that job exists |
| `ana.say(text, { channel })` | Done | Built, with browser | Browser (typed in Slack's client) | The platform sends real `message` and `app_mention` events only for a message a person types. Slack marks every message posted through its API with the posting app's `bot_id` and `app_id`, a person's user token included (`as_user` too), and agents drop it as a bot's (found against the sandbox, [decision 0015](decisions/0015-live-mode.md)). The browser actor types it in Slack's client, from a session saved with `channelstack login`; without one, live runs report `action_requires` |
| `ana.say(text, { to: slack.app })` (DM) | Done | Built, with browser | Browser; the DM is opened with the user token (`conversations.open`) | Fires `message.im`. As `say` in a channel |
| `ana.say(text, { to: [ben, slack.app] })` (group DM) | Done | Built, with browser | Browser | As `say` in a channel |
| `ana.say({ files })` | Yes | Yes, with browser | Browser | As `say` in a channel |
| `ana.reply(text, { thread })` | Done | Built, with browser | Browser | `alsoSendToChannel` → `reply_broadcast`. As `say` in a channel |
| `ana.edit(text, { message })` | Done | Built | User token (`chat.update`) | Only the person's own messages, as in Slack. **unverified**: whether an edit through the API carries the posting app's bot as a new message does |
| `ana.delete({ message })` | Done | Built | User token (`chat.delete`) | |
| `ana.react` / `unreact` | Done | Built | User token (`reactions.add` / `remove`) | |
| `ben.click("Approve", { message })` | Done | Built, with browser | Browser | Confirmed: `block_actions` is only sent when a real person clicks; there's no API to trigger it |
| `ana.select(option, { menu, message })` | Done | Yes, with browser | Browser | Same as click |
| `ben.waitForModal()` | Done | Yes, with proxy or browser | Proxy (sees `views.open`) or Browser (sees the modal) | |
| `modal.submit(values)` / `close()` | Done | Yes, with browser | Browser | Confirmed: no API sends `view_submission` as a user |
| `ana.shortcut(callbackId, { message })` | Done | Yes, with browser | Browser | |
| `ana.runCommand("/deploy web", { channel })` | Done | Yes, with browser | Browser | Confirmed: the official docs only cover receiving commands. `chat.command` exists only in community sources (undocumented, legacy tokens), so channelstack doesn't use it |
| `ana.stop({ thread })` | Done | Yes, with browser | Browser | Confirmed: Stop is a native client button that sends the app `agent_session_stopped`. It only appears when the app subscribes to that event, and no API presses it. The fake models the follow-up too: `chat.appendStream` returns `stopped_by_user` |
| `ana.openDM(slack.app)` | Done | Built | User token (`conversations.open`) | |
| `ana.openAgentThread()` | Done | Yes, with browser | Browser | Confirmed: `assistant_thread_started` fires only when the person opens the assistant container, and no API triggers it |
| `ana.pickPrompt(title, { thread })` | Done | Partial | Browser, or User token | The browser clicks the suggested prompt. A User-token fallback posts the prompt's text into the thread, which looks the same to the agent but isn't a click |
| `ana.switchContext(channel, { thread })` | Done | Yes, with browser | Browser | `assistant_thread_context_changed` comes from the client |
| `ana.invite` / `kick` | Done | Built | User token (`conversations.invite` / `kick`) | Kicking needs the right workspace role |
| `ana.renameChannel` / `archiveChannel` | Yes | Yes | User token | Not in the fake or live yet |
| `ana.ephemeral()` | Done | Yes, with proxy or browser | Proxy (sees `chat.postEphemeral`) or Browser | Confirmed: ephemeral messages aren't stored and don't persist across reloads, so no read API returns them. The browser only sees them while the page stays open |
| `channel.messages()`, `thread.replies()`, `waitForReply`, `latestReply` | Done | Built | User token (`conversations.history` / `replies`) | Polled, from reads cached for a second (Slack's read methods allow about one call a second). `latestReply` waits until the agent is quiet first, which live needs proxy mode for |
| `message.reactions()` | Done | Built | User token (the reactions in `conversations.history` / `replies`) | |
| `message.stream` (chunks and state) | Done | Partial | Proxy (sees `chat.startStream` / `appendStream` / `stopStream`) | **unverified**: whether history returns partial text during a stream. The docs only say a stream that times out after 10 minutes keeps what was streamed. Without proxy, count on seeing only the final text |
| `thread.status()`, `toHaveStatus`, `toHaveStatusText` | Done | Yes, with proxy or browser | Proxy (sees `assistant.threads.setStatus` and its replacement `agents.sessions.setStatus`) or Browser | Confirmed: only write methods exist, nothing reads the status back. The fake serves both method names |
| `agentThread.suggestedPrompts()` | Done | Yes, with proxy or browser | Proxy or Browser | Confirmed: no read API |
| `toBeEphemeralFor(user)` | Done | Yes, with proxy or browser | Same as `ephemeral()` | |
| `toHaveButton(label)` | Done | Built | User token (the blocks are in history) | |
| `toHaveOpenedModal(title)` | Done | Yes, with proxy or browser | Same as `waitForModal` | |
| `delivery.retry({ after: "3s" })` | Done | No | — | Fake-only. channelstack doesn't sit between the platform and the agent live |
| Socket Mode delivery | Done | Agent's concern | — | Live, the agent connects to Slack itself |

---

## GitHub

The live backend isn't built yet. With the App's credentials set (`CHANNELSTACK_GITHUB_APP_ID`, `CHANNELSTACK_GITHUB_PRIVATE_KEY`), every GitHub operation reports `unsupported_in_live` and its test is skipped (the nightly job then fails for it, since its live block passed nothing), until the test org exists.

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `github.createRepo({ files, collaborators, labels })` | Done | Yes | Seeding credentials (org admin) | Created in the test org, deleted at the end of the session. Collaborator invites are accepted with each user's token |
| `github.createRepo({ apps: [github.app] })` | Done | Yes | Seeding credentials (`PUT /user/installations/{id}/repositories/{repo}`), or the installation set to "all repositories" | Confirmed: works with a fine-grained PAT that has "GitHub App installation repository access" write permission, or a GitHub App user access token; the user needs admin on the repo. The first install of the App on the org happens once, in a browser |
| `repo.installApp` / `uninstallApp` | Done | Yes | Same as above; removing the whole installation uses App credentials (`DELETE /app/installations/{id}`) | |
| `ana.push(changes, { repo, branch })` | Done | Yes | User token (Git Data or Contents API) | Fires real `push` events |
| `ana.openIssue` / `openPullRequest` | Done | Yes | User token | `openPullRequest({ changes })` pushes the branch first |
| `ana.editIssue`, `close`, `reopen` | Done | Yes | User token | |
| `ana.label` / `unlabel` | Done | Yes | User token | |
| `ana.assign([ben], { issue })` | Done | Yes | User token | |
| `ana.assign(github.app, { issue })` | Done | No | — | The contract takes the app here (`api/github.d.ts`), so the fake accepts it and sends `assigned`. **Unverified live**, likely refused for an ordinary App: the docs don't cover bot assignees, and community reports say it fails. Confirm in the first live spike, then either refuse in the fake or keep it |
| `ana.comment(text, { issue })` | Done | Yes | User token | `@my-agent` becomes a real mention |
| `ana.edit` / `delete` (comments) | Done | Yes | User token | |
| `ana.react(content, { issue \| comment })` | Done | Yes | User token | |
| `ana.minimize({ comment })` | Done | Yes | User token (GraphQL `minimizeComment`) | |
| `ana.review({ pr, event, comments })` | Done | Yes | User token | Inline comments become `pull_request_review_comment` |
| `ana.reviewComment(text, { pr, path, line })` | Done | Yes | User token | |
| `ana.reply(text, { comment })` (review thread) | Done | Yes | User token | |
| `ana.resolve` / `unresolve` | Done | Yes | User token (GraphQL `resolveReviewThread`) | |
| `ana.requestReview([ben], { pr })` | Done | Yes | User token | |
| `ana.requestReview(github.app, { pr })` | Done | No | — | As above: the contract takes the app, the fake accepts it and sends `review_requested`. **Unverified live**, likely refused: the endpoint takes user logins and team slugs only |
| `ana.markReady({ pr })` / `merge({ pr })` | Done | Yes | User token | |
| `ana.rerun({ checkRun })` | Done | Not yet | — | Not in the first release. Confirmed: `rerequest` returns 403 unless the caller is the App that owns the check run, so a person's Re-run is a UI click. Live runs report `unsupported_in_live` |
| `ana.requestAction(id, { checkRun })` | Done | Yes, with browser | Browser | Confirmed: no API; clicking only sends the `check_run.requested_action` webhook |
| `pr.checkRuns()`, `commit.statuses()`, `toHaveCheckRun` | Done | Yes | User token | |
| `issue.comments()`, `pr.reviews()`, `reviewComments()`, `toHaveCommentsFrom`, `toHaveReviewComment`, `toBeMerged` | Done | Yes | User token | |
| `repo.readFile(path, { ref })` | Done | Yes | User token | |
| `github.appCalls()` | Done | Yes, with proxy | Proxy (sees the App's calls) | The App's calls about no repository: its own endpoints and the token exchange. Fake: the same list for every session |
| `delivery.redeliver()` | Done | Yes | App credentials (`POST /app/hook/deliveries/{id}/attempts`, App JWT) | Confirmed. GitHub redelivers to the agent's own webhook URL |
| `delivery.attempts`, `status` for the agent's webhook | Done | Yes | App credentials (`GET /app/hook/deliveries`, App JWT) | Read-only: GitHub's delivery log shows each delivery to the agent, its status code and duration. channelstack stays out of the path |

---

## Linear

The live backend is built: people act with their personal API keys, reads go through the app's OAuth token, and a session's teams are deleted when it closes ([decision 0015](decisions/0015-live-mode.md)). Rows marked **Yes** below are built unless their notes say otherwise. Against the sandbox (2026-11-23), a person, a team, an issue and the delegation work; Linear opened no agent session, because the app's webhook doesn't reach a running agent yet.

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `linear.createTeam({ key, members, states, labels })` | Done | Built | The first real member's key (`teamCreate`); a person with a key is needed, the app can't create teams | Generated keys avoid collisions. Deleted (or archived) at the end of the session |
| `ana.createIssue({ … }, { team })` | Done | Built | User token (`issueCreate`) | |
| `ana.createIssue({ delegate: linear.app })` | Done | Built | User token (`issueCreate` with `delegateId`) | Confirmed |
| `ana.editIssue`, `assign`, `setState`, `label` | Done | Built | User token (`issueUpdate`) | |
| `ana.delegate(linear.app, { issue })` | Done | Built | User token (`issueUpdate` with `delegateId`) | Confirmed: changing the delegate can start an agent session |
| `ana.undelegate({ issue })` | Done | Built | User token (`issueUpdate` with `delegateId: null`) | Confirmed |
| `ana.comment("@my-agent …", { issue })` | Done | Built | User token (`commentCreate`) | Confirmed for people: channelstack writes the profile URL (`https://linear.app/<workspace>/profiles/<user>`) into the Markdown body, and Linear turns it into a mention. **unverified** whether an app's profile URL opens a session the same way |
| `ana.reply` / `edit` / `delete` / `react` (comments) | Done | Built | User token | |
| `ana.prompt(text, { session })` | Done | Built | User token (`commentCreate` with `parentId` set to the session's root comment) | **unverified**: the docs say a person's new message in a session sends `prompted`, but don't say an API reply counts. First live spike |
| `ana.answer(text, { elicitation })` | Done | Built | User token (same as prompt) | |
| `ana.stop({ session })` | Done | Yes, with browser | Browser | Confirmed: the `stop` signal is only generated when a person presses Stop in Linear, and it can't be published through `agentActivityCreate` |
| `session.state()`, `activities()`, `plan()`, `externalUrls()`, `toHaveSessionState`, `toHaveActivity` | Done | Built | App credentials (`agentSessions`, `agentSession`: the app's own sessions) | |
| `issue.comments()`, `toHaveCommentFrom`, `toBeDelegatedTo`, `toHaveState` | Done | Built | User token | |
| `delivery.redeliver()` | Done | No | — | Fake-only. Linear has no redelivery mutation. The fake stamps a new `webhookTimestamp` into the body and signs it again, as Linear's own retries do |
| An agent's `response`, `elicitation` and `error` as comments | Done | Yes | — | **unverified**: the fake writes them as the app's comments in the session's thread (the mention, or for a delegation a thread of their own), with the activity's `sourceComment` on that comment. The Chat SDK's Linear adapter relies on a response having one. First live spike |
| Webhook deliveries to the agent | Done | Agent's concern | — | Linear delivers to the agent's own webhook URL |

---

## Notion

Built (phase 5) and checked against the sandbox workspace on 2026-11-24. With the integration's token set (`CHANNELSTACK_NOTION_TOKEN`), Notion runs live: people act with their personal access tokens (`CHANNELSTACK_NOTION_USER_<NAME>_TOKEN`). Each session's pages go in a page of its own (`channelstack-run-<run>-<n>`) under the one page the integration is connected to (or `CHANNELSTACK_NOTION_PAGE`), made by the session's first person, and that page goes to the trash when the session closes. A page the integration must not see goes under `CHANNELSTACK_NOTION_UNSEEN_PAGE` (without it, `live_misconfigured`).

Found against the sandbox: every token answers `users/me` as a bot; a personal access token's bot is owned by its person (`bot.owner.user`). A comment made with it is by the person, but a page is by the token's bot. A person's name in Notion can be their email: the live world uses the test's name for them and never returns Notion's. Comments can be anchored to a block (`parent.block_id`), edited and deleted through the API.

Notion now has **personal access tokens** that act as the person who created them, with that person's permissions and no page sharing. That's the "User token" for Notion, and it makes most person actions possible live. The integration's own token (internal or public OAuth) always acts as a bot.

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `notion.createPage({ content, connections })` (seed) | Done | Built | Seeding credentials (a seeding PAT), under a parent page the agent's integration is connected to once, by hand | Confirmed: sharing a parent gives access to all child pages, which is how `connections: [notion.app]` works live |
| `notion.createPage({ connections: [] })` (agent not connected) | Done | Built | Seeding credentials, under a parent the agent can't see | |
| `notion.createDatabase({ properties, rows })` | Done | Not yet | Seeding credentials | |
| `ana.createPage(...)` (as a person) | Done | Built | User token (PAT) | |
| `ana.comment(text, { page, anchor })` | Done | Built | User token (PAT) | Confirmed: a PAT-made comment's `created_by` is the person. `anchor` comments on the block with that text (`parent.block_id`) |
| `ana.reply(text, { discussion })` | Done | Built | User token (PAT, comment with `discussion_id`) | |
| `ana.editComment` / `deleteComment` | Done | Built | User token (PAT) | Content only |
| `ana.resolve` / `reopen` (discussion) | Done | Not yet | — | Not in the first release. Confirmed: the REST API has no resolve action, so a person's resolve is a UI click (browser actor later) |
| `ana.edit({ append }, { page })`, `rename` | Done | Built | User token (PAT) | |
| `ana.setProperty`, `addRow` | Done | Not yet | — | With databases |
| `ana.mention(notion.app, { page })` | Done | Built | User token (PAT) | **unverified**: whether an in-body mention of an integration reaches the agent as an event |
| `ana.connect` / `disconnect(notion.app, { page })` | Done | Yes, with browser (not built) | Browser ("Add connections" in the page menu) | Confirmed: no API adds or removes a connection |
| `page.markdown()`, `blocks()`, `discussions()`, `children()`, `connections()`, `transcript()`, `toHaveBlock`, `toHaveCommentFrom` | Done | Built | The session's first person's token (read APIs) | A page is read again before each read (cached for a second). Discussions are read on the page and on the blocks that have one already: a discussion the agent starts on another block isn't seen |
| `page.property()`, `database.rows()`, `toHavePropertyValue` | Done | Not yet | — | With databases |
| `discussion.resolved()` | Done | Not yet | — | No resolved field in the REST API. Follows `resolve` |
| Webhook deliveries (`comment.created`, `page.*`) | Done | Agent's concern | — | Notion delivers to the agent's own URL. The fake signs `X-Notion-Signature: sha256=<HMAC-SHA256 of the body, keyed with the verification token>`, batches `page.content_updated` the way Notion does, and retries like Notion (up to 8 times over about 24 hours) |
| `delivery.resend()` / redelivery | Done | No | — | Fake-only. Notion has no redelivery API. A redelivery is the same event with the next `attempt_number`, signed again |
| `notion.setContentUpdateDelay(delay)` | Done | No | — | Fake-only: how long `page.content_updated` is held to batch edits (default one second). Notion doesn't document its window |
| `notion.sendVerification()` | Done | No | — | Fake-only: the `{ verification_token }` request Notion sends once when a subscription is created |
| Events the integration caused itself | Done | Yes | — | **unverified**: the fake sends them (its own comments, edits and property changes), with the bot in `authors`, so an agent must ignore its own. The checks assume that |

---

## What this means for test authors

1. **Most of a test runs live with plain tokens.** Commenting, reviewing, delegating and every read work on all four platforms through a person's token, including Notion, now that it has personal access tokens. Slack is the exception for messages: one posted through the API carries the posting app's bot, so a person's `say` and `reply` are typed in the client by the browser actor.
2. **The UI-only actions** are:
   - Slack: a person's messages (`say`, `reply`), clicks, modals, slash commands, Stop and the agent split view.
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

Answered so far (2026-11-23, Slack sandbox):

- **V1, Slack A2: not possible through the API; blocked on the browser actor.** channelstack's side works against real Slack: the tagged channel, the invite, reading the thread back, and cleanup (the sweep check found nothing left). But Slack marks every message posted through its API with the posting app's `bot_id` and `app_id`, a person's user token included, whichever app issued it (a separate app for the sandbox's people was tried) and with `as_user=true` too. The reference agent, most agents and `slackChecks()` ("ignores other bots") drop such a message, so no API post of a person's reaches the agent. A person's message needs Slack's client: live `say` and `reply` go through the browser actor. **Answered 2026-11-24:** the browser actor types the message in Slack's client, the real agent replies, and the reply is read back (about 7 seconds from Chrome's start to the typed message, then the agent's time).
- **A DM with an app in Slack's agent view is one long thread.** With the app's agent view on, the DM has a root message ("New Assistant Thread", subtype `assistant_app_thread`) and every exchange is a reply under it, shown in the main pane with no thread pane. The live world reads a typed DM message back from those replies too, the browser actor uses the conversation's composer and buttons there, and cleanup deletes the session's replies with the app's answers after each one (the root stays).
- **A real click reaches the agent (V4, 2026-11-24).** The browser actor finds the app's Approve button in the agent-view thread and clicks it; Slack sends the agent `block_actions`, and its "deploying" answer is read back from the thread. The reference agent lets only workspace admins approve and answers anyone else ephemerally, which no API reads back, so the example asks for an admin: live, `createUser` refuses an `admin`, `owner` or `guest` option the real account doesn't match (`live_misconfigured`). Stop isn't built yet.
- **Slack's read methods ignore a JSON body.** `users.info` answers `user_not_found` to one; the live client sends parameters form-encoded, as Slack's SDK does.

- **Linear: delegating through the API opens no agent session while the app's webhook doesn't reach a running agent.** A person's key creates the team and the issue and sets the delegate; Linear records it, and the app sees the team. But Linear opened no session for it (the app's earlier sessions, from 2026-11-06, show it did when its webhook worked). The live backend waits 15 seconds for the session and then says so.
- **Linear refuses a query that is too complex** (over 10,000 points): every agent session with its activities in one query is. The live backend lists the app's sessions by id and reads each one on its own.

Still open:

1. **Slack:** does `conversations.replies` show partial text while a message streams?
2. **GitHub:** are App bots refused as assignees and reviewers? The fake accepts both, because the contract does; if GitHub refuses, the contract and the fake change together.
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
