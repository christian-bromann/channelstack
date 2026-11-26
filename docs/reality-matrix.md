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
| **Yes, with proxy / browser** | Works live, but only with that extra piece (below). The browser actor is built (phase 5). Proxy mode is built (phase 6, `start --proxy`) and passes a live agent's calls on to the platform, but doesn't read them back yet ([#24](https://github.com/christian-bromann/channelstack/issues/24)): until it does, those steps report `action_requires` live, and the framework skips them |
| **Agent's concern** | Live, the platform delivers to the agent directly. channelstack never relays events to an agent; how the agent is reachable (public URL, Socket Mode, a deployed staging agent) is up to the agent |
| **Partial** | Works live with a visible difference, explained in "Notes" |
| **Not yet** | Possible on the real platform, but not in the first release. Live runs report `unsupported_in_live`, like **No** |
| **No** | No way to do it on the real platform. Live runs report `unsupported_in_live` and the framework skips the step, so the test still runs fake on every PR |
| **unverified** | The docs don't settle it. Needs a live spike |

**How it's done live**

| Code | What it is |
|---|---|
| **User token** | The person's own credential: Slack `xoxp`, a GitHub PAT for a machine user, a Linear personal API key, a Notion personal access token |
| **App credentials** | The agent app's own credentials, from the environment (`CHANNELSTACK_<CHANNEL>_*`, [live-mode.md](live-mode.md), section 4): Slack bot token, GitHub App JWT, Linear OAuth app, Notion integration token |
| **Seeding credentials** | A separate admin token channelstack uses to set up places (channels, repos, teams, pages), so setup doesn't look like the agent acting |
| **Browser** | A browser actor: WebdriverIO BiDi driving the real web UI as a sandbox person. It never signs in itself: it uses the session a person saved by hand with `channelstack login slack` (see [Browser sessions](#browser-sessions)), and reuses it between runs. Used only where the platform has no API for a person's action |
| **Proxy** | Proxy mode in pass-through: the agent's calls to the real platform go through channelstack, which records them (and can inject faults). Needed to observe the agent's calls live |
| **Pre-provisioned** | Exists in the sandbox ahead of time, because the platform has no API to create it. `createUser({ name: "Ana" })` maps to the sandbox account by name (`CHANNELSTACK_<CHANNEL>_USER_ANA_TOKEN`) |

**What a developer can provide, and what that turns live**

| Credentials | What runs live |
|---|---|
| App credentials only (e.g. just a bot token) | Acting as the app: posting as the bot, installing it, reading. No person actions, because a bot token never acts as a person |
| Plus a user token per sandbox person | Most of the matrix: say, reply, react, edit, DMs, comments, reviews, delegation, reads |
| Plus a saved browser session per person (`channelstack login slack`) | The browser rows, as real UI actions (built for Slack) |

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
| Isolation per test (fresh places) | Done | Built (Slack) | A person's token | Live places get a `channelstack-run-<run>-<world>-<n>` name and are removed at the end of the session (cleanup ledger): Slack channels are archived (Slack can't delete one outside Enterprise Grid), and what the session wrote in a DM is deleted. `channelstack sweep` removes what a crashed run left ([decision 0015](decisions/0015-live-mode.md)) |
| `delivery.attempts`, `status`, `settled()` | Done | No (GitHub: read-only, see below) | — | Fake-only. Live, the platform delivers to the agent directly and channelstack isn't in the path |
| `toBeAccepted({ within })` | Done | No (GitHub: from the delivery log) | — | Fake-only, except GitHub's delivery log records the agent's response time |
| `delivery.resend({ badSignature, stale })` | Done | No | — | Fake-only |
| `toBeRejected()` | Done | No (GitHub: from the delivery log) | — | Fake-only, except GitHub's delivery log records the agent's status code |
| `calls()`, `waitForCall()`, `toHaveReceivedCall()` | Done | Yes, with proxy | Proxy | In base-URL mode the agent talks straight to the platform, so channelstack sees nothing |
| `fault(...)`: rate limits, latency, errors | Done | Yes, with proxy | Proxy | Injected by the proxy on the way to the real platform. Real rate limits also apply |
| "Agent is quiet" (negative and exact-count matchers) | Done | Yes, with proxy | Proxy | With proxy: no call in flight and no open stream. Live without proxy, nothing tells channelstack when the agent is done: a session that acted live gets `action_requires`, and those matchers skip. Positive matchers poll and work. A fallback (the transcript unchanged for `quietFor`) is possible later |
| `transcript()` and all `toContainText…` matchers | Done | Built (Slack) | User token or App credentials | Built from the platform's read APIs, using the same renderer as the fake |
| `channelstack.reset()` | Done | No | — | Live cleanup is per session (cleanup ledger) plus `channelstack sweep`. A real workspace is never wiped |

---

## Slack

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `slack.createChannel({ participants, private })` | Done | Built | User token of the first real person in it (`conversations.create`, `conversations.invite`) | Including `slack.app` invites the bot. The app's bot can't create channels, so a person does; no separate seeding token is needed |
| `slack.createChannel({ shared: true })` (Slack Connect) | Yes | No | — | Needs a second organization and manual approval |
| `slack.uninstallApp()` | Done | Not yet | App credentials (`apps.uninstall` with the token, `client_id` and `client_secret`) | Revokes every token of the installation. Reinstalling needs the OAuth consent flow in a browser, so it belongs in a dedicated nightly job, not in every run. Live runs report `unsupported_in_live` until that job exists |
| `ana.say(text, { channel })` | Done | Built, with browser | Browser (typed in Slack's client) | The platform sends real `message` and `app_mention` events only for a message a person types. Slack marks every message posted through its API with the posting app's `bot_id` and `app_id`, a person's user token included (`as_user` too), and agents drop it as a bot's (found against the sandbox, [decision 0015](decisions/0015-live-mode.md)). The browser actor types it in Slack's client, from a session saved with `channelstack login`; without one, live runs report `action_requires`. A person types text: `blocks` and `metadata` are an app's, and live `say` refuses them (`unsupported_in_live`) |
| `ana.say(text, { to: slack.app })` (DM) | Done | Built, with browser | Browser; the DM is opened with the user token (`conversations.open`) | Fires `message.im`. As `say` in a channel |
| `ana.say(text, { to: [ben, slack.app] })` (group DM) | Done | Built, with browser | Browser | As `say` in a channel |
| `ana.reply(text, { thread })` | Done | Built, with browser | Browser | Typed in the thread, as `say` in a channel. `alsoSendToChannel` (`reply_broadcast`) isn't live yet: `unsupported_in_live` |
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
| `ana.ephemeral()` | Done | Yes, with proxy or browser | Proxy (sees `chat.postEphemeral`) or Browser | Confirmed: ephemeral messages aren't stored and don't persist across reloads, so no read API returns them. The browser only sees them while the page stays open |
| `channel.messages()`, `thread.root()`, `thread.replies()`, `waitForReply`, `latestReply` | Done | Built | User token (`conversations.history` / `replies`) | Polled, from reads cached for a second (Slack's read methods allow about one call a second). `latestReply` waits until the agent is quiet first, which live needs proxy mode for |
| `message.reactions()` | Done | Built | User token (the reactions in `conversations.history` / `replies`) | |
| `message.stream` (chunks and state) | Done | Partial | Proxy (sees `chat.startStream` / `appendStream` / `stopStream`) | **unverified**: whether history returns partial text during a stream. The docs only say a stream that times out after 10 minutes keeps what was streamed. Without proxy, count on seeing only the final text |
| `thread.status()`, `toHaveStatus`, `toHaveStatusText` | Done | Yes, with proxy or browser | Proxy (sees `assistant.threads.setStatus` and its replacement `agents.sessions.setStatus`) or Browser | Confirmed: only write methods exist, nothing reads the status back. The fake serves both method names |
| `thread.suggestedPrompts()` (agent split view) | Done | Yes, with proxy or browser | Proxy or Browser | Confirmed: no read API |
| `toBeEphemeralFor(user)` | Done | Yes, with proxy or browser | Same as `ephemeral()` | |
| `toHaveButton(label)` | Done | Built | User token (the blocks are in history) | |
| `toHaveOpenedModal(title)` | Done | Yes, with proxy or browser | Same as `waitForModal` | |
| `delivery.retry({ after: "3s" })` | Done | No | — | Fake-only. channelstack doesn't sit between the platform and the agent live |
| Socket Mode delivery | Done | Agent's concern | — | Live, the agent connects to Slack itself |

---

## GitHub

Built (phase 5), and checked against the test organization on 2026-11-24: the App's installation made the repository, Ana was invited and accepted, opened an issue, commented and labelled it as herself, it was read back, and the repository was deleted when the session closed. GitHub delivered `issues` and `issue_comment` to the App's webhook; its delivery log shows a delivery a few seconds after it was sent. Only an organization lets the App make and delete the test repositories, so a user account can't be the test org. With the App's credentials set (`CHANNELSTACK_GITHUB_APP_ID`, `CHANNELSTACK_GITHUB_PRIVATE_KEY`), GitHub runs live. The App's installation on the allowlisted org makes each session's repositories (`channelstack-run-<run>-<world>-<n>[-<name>]`, deleted when the session closes) and needs the Administration permission; people act with their own tokens (`CHANNELSTACK_GITHUB_USER_<LOGIN>_TOKEN`), and a person's `login` must be their account's. An installation on selected repositories can't take `apps: [github.app]`, and one on all repositories can't make a repository without it.

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `github.createRepo({ files, collaborators, labels })` | Done | Built | The App's installation token (Administration, Contents, Issues: write) | Created in the test org (`POST /orgs/{org}/repos`), tagged, deleted at the end of the session. A collaborator outside the org is invited and accepts with their own token |
| `github.createRepo({ apps: [github.app] })` | Done | Built | The App's installation on all of the org's repositories | Live, the installation covers every repository: on one with selected repositories, `apps: [github.app]` is `live_misconfigured`, and on one with all, a repository without `apps` is `unsupported_in_live` (the App hears about every one). The first install of the App on the org happens once, in a browser |
| `repo.installApp` / `uninstallApp` | Done | Not yet | Same as above; removing the whole installation uses App credentials (`DELETE /app/installations/{id}`) | |
| `ana.push(changes, { repo, branch })` | Done | Not yet | User token (Git Data or Contents API) | Fires real `push` events |
| `ana.openIssue` | Done | Built | User token | |
| `ana.openPullRequest` | Done | Not yet | User token | `openPullRequest({ changes })` pushes the branch first |
| `ana.editIssue`, `close`, `reopen` | Done | Built | User token | |
| `ana.label` / `unlabel` | Done | Built | User token | |
| `ana.assign([ben], { issue })` | Done | Built | User token | |
| `ana.assign(github.app, { issue })` | Done | No | — | The contract takes the app here (`api/github.d.ts`), so the fake accepts it and sends `assigned`. **Unverified live**, likely refused for an ordinary App: the docs don't cover bot assignees, and community reports say it fails. Confirm in the first live spike, then either refuse in the fake or keep it |
| `ana.comment(text, { issue })` | Done | Built | User token | `@my-agent` becomes a real mention |
| `ana.edit` / `delete` (comments) | Done | Built | User token | |
| `ana.react(content, { issue \| comment })` | Done | Built | User token | |
| `ana.minimize({ comment })` | Done | Not yet | User token (GraphQL `minimizeComment`) | |
| `ana.review({ pr, event, comments })` | Done | Not yet | User token | Inline comments become `pull_request_review_comment` |
| `ana.reviewComment(text, { pr, path, line })` | Done | Not yet | User token | |
| `ana.reply(text, { comment })` (review thread) | Done | Not yet | User token | |
| `ana.resolve` / `unresolve` | Done | Not yet | User token (GraphQL `resolveReviewThread`) | |
| `ana.requestReview([ben], { pr })` | Done | Not yet | User token | |
| `ana.requestReview(github.app, { pr })` | Done | No | — | As above: the contract takes the app, the fake accepts it and sends `review_requested`. **Unverified live**, likely refused: the endpoint takes user logins and team slugs only |
| `ana.markReady({ pr })` / `merge({ pr })` | Done | Not yet | User token | |
| `ana.rerun({ checkRun })` | Done | Not yet | — | Not in the first release. Confirmed: `rerequest` returns 403 unless the caller is the App that owns the check run, so a person's Re-run is a UI click. Live runs report `unsupported_in_live` |
| `ana.requestAction(id, { checkRun })` | Done | Yes, with browser | Browser | Confirmed: no API; clicking only sends the `check_run.requested_action` webhook |
| `pr.checkRuns()`, `commit.statuses()`, `toHaveCheckRun` | Done | Not yet | User token | |
| `issue.comments()`, `transcript()`, `toHaveCommentFrom`, `toHaveCommentsFrom` | Done | Built | The App's installation (read APIs) | An issue is read again before each read (cached for a second) |
| `pr.reviews()`, `reviewComments()`, `toHaveReviewComment`, `toBeMerged`, `comment.reactions()` | Done | Not yet | User token | With pull requests |
| `repo.readFile(path, { ref })` | Done | Built | User token | |
| `github.appCalls()` | Done | Yes, with proxy | Proxy (sees the App's calls) | The App's calls about no repository: its own endpoints and the token exchange. Fake: the same list for every session |
| `delivery.redeliver()` | Done | Built | App credentials (`POST /app/hook/deliveries/{id}/attempts`, App JWT) | Confirmed. GitHub redelivers to the agent's own webhook URL |
| `delivery.attempts`, `status` for the agent's webhook | Done | Built | App credentials (`GET /app/hook/deliveries`, App JWT) | Read-only: GitHub's delivery log shows each delivery to the agent, its status code and duration. channelstack stays out of the path. The log lags: a delivery shows a few seconds after GitHub sent it, so a test polls `deliveries()` (the live example uses `expect.poll(…, { timeout: 30_000 })`) |

---

## Linear

The live backend is built: people act with their personal API keys, reads go through the app's OAuth token, and a session's teams are deleted when it closes ([decision 0015](decisions/0015-live-mode.md)). Rows marked **Yes** below are built unless their notes say otherwise. Against the sandbox, a person, a team, an issue and the delegation work. On 2026-11-23 Linear opened no agent session, because the app's webhook reached no agent; since 2026-11-24 the webhook goes to a relay channel that `pnpm live` forwards to the reference agent, and the live example passes: Linear opens the session, and the agent's activity is read back.

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
| `issue.comments()`, `toHaveCommentFrom`, `toBeDelegatedTo`, `toHaveState` | Done | Built | The app's OAuth token (read APIs) | An issue is read again before each read (cached for a second) |
| `delivery.redeliver()` | Done | No | — | Fake-only. Linear has no redelivery mutation. The fake stamps a new `webhookTimestamp` into the body and signs it again, as Linear's own retries do |
| An agent's `response`, `elicitation` and `error` as comments | Done | Yes | — | **unverified**: the fake writes them as the app's comments in the session's thread (the mention, or for a delegation a thread of their own), with the activity's `sourceComment` on that comment. The Chat SDK's Linear adapter relies on a response having one. First live spike |
| Webhook deliveries to the agent | Done | Agent's concern | — | Linear delivers to the agent's own webhook URL |

---

## Notion

Built (phase 5) and checked against the sandbox workspace on 2026-11-24. With the integration's token set (`CHANNELSTACK_NOTION_TOKEN`), Notion runs live: people act with their personal access tokens (`CHANNELSTACK_NOTION_USER_<NAME>_TOKEN`). Each session's pages go in a page of its own (`channelstack-run-<run>-<world>-<n>`) under the one page the integration is connected to (or `CHANNELSTACK_NOTION_PAGE`), made by the session's first person, and that page goes to the trash when the session closes. A page the integration must not see goes under `CHANNELSTACK_NOTION_UNSEEN_PAGE` (without it, `live_misconfigured`).

Found against the sandbox: every token answers `users/me` as a bot; a personal access token's bot is owned by its person (`bot.owner.user`). A comment made with it is by the person, but a page is by the token's bot. A person's name in Notion can be their email: the live world uses the test's name for them and never returns Notion's. Comments can be anchored to a block (`parent.block_id`), edited and deleted through the API.

Notion now has **personal access tokens** that act as the person who created them, with that person's permissions and no page sharing. That's the "User token" for Notion, and it makes most person actions possible live. The integration's own token (internal or public OAuth) always acts as a bot.

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `notion.createPage({ content, connections })` (seed) | Done | Built | The session's first person's token, in the session's own page under the page the integration is connected to once, by hand | Confirmed: sharing a parent gives access to all child pages, which is how `connections: [notion.app]` works live. Without a real person in the session, `action_requires` |
| `notion.createPage({ connections: [] })` (agent not connected) | Done | Built | The session's first person's token, under `CHANNELSTACK_NOTION_UNSEEN_PAGE` | Without that page, `live_misconfigured` |
| `notion.createDatabase({ properties, rows })` | Done | Not yet | — | With databases |
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

## Resend

Built in phase 8, against stand-ins; checked against real Resend teams once the sandbox teams exist (exit check 8.7). An agent on Resend has a team: an API key and a verified domain that sends and receives. With its key set (`CHANNELSTACK_RESEND_API_KEY`), Resend runs live: each person is a team of their own (`CHANNELSTACK_RESEND_USER_<NAME>_TOKEN`), with an address on that team's verified domain. A person's email goes out through Resend from their team; the agent's answers are read back from what that team received. The agent's address is `CHANNELSTACK_RESEND_ADDRESS`, or `my-agent@` its team's domain.

Sent email can't be taken back. Live, every recipient must be at a domain in `CHANNELSTACK_LIVE_RESEND_DOMAINS` (or a `@resend.dev` test address), checked before Resend is asked to send; a run tags what it sends with an `X-Channelstack-Run` header. The sweep has nothing to remove.

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `resend.createUser({ name, address, token })` | Done | Built | The person's own team's key; their address on its verified domain | A person is their mailbox: their `id` is their address. In the fake, `<name>@example.com` |
| `ana.send({ to, cc, subject, text, html })` | Done | Built | `POST /emails` with the person's key | To the agent's address it reaches the agent's team as a received email (`email.received`). Attachments aren't built yet, fake or live |
| `ana.reply(email, { text, all })` | Done | Built | `POST /emails`, with `In-Reply-To` and `References` | `Re:` its subject, to its sender (`Reply-To` first), and with `all` to everyone on it |
| `ana.inbox()`, `waitForEmail` | Done | Built | The person's team's receiving API | Read again before each read (cached for a second) |
| `thread.messages()`, `replies()`, `transcript()`, `toHaveReplyFrom` | Done | Built | Each person's received mail | A thread is the emails joined by `In-Reply-To` and `References`. A transcript has each email's own words, without the quoted history |
| The agent's API (`emails.send`, `batch.send`, `emails.receiving.get` and `list`, `emails.get`, `domains.list`) | Done | Agent's concern | — | The fake answers as Resend's description says (exit check 8.3), with Resend's error shape (`{ statusCode, name, message }`), `Idempotency-Key`, the `@resend.dev` test addresses, and 10 requests a second (counted per test session in the fake) |
| Webhook deliveries (`email.received`, `email.sent`, `email.delivered`, …) | Done | Agent's concern | — | Resend delivers to the agent's own URL. The fake signs as Svix does (`svix-id`, `svix-timestamp`, `svix-signature`) and retries on Resend's schedule (5 s, 5 min, 30 min, 2, 5, 10 and 10 h) |
| `delivery.resend()` / redelivery | Done | No | — | Fake-only. Resend replays a webhook only from its dashboard |
| `resend.calls()`, `waitForCall`, `toHaveReceivedCall` | Done | Yes, with proxy | Proxy mode | Resend doesn't report the team's calls |

## Google

Built in phase 9, against stand-ins; checked against real Gmail accounts once the sandbox accounts exist (exit check 9.7). An agent on Gmail has a mailbox it reads and sends from through the Gmail API (`googleapis`), with an OAuth client and its mailbox's refresh token, and a Pub/Sub topic its `users.watch` pushes to. With those set (`CHANNELSTACK_GOOGLE_CLIENT_ID`, `CHANNELSTACK_GOOGLE_CLIENT_SECRET`, `CHANNELSTACK_GOOGLE_REFRESH_TOKEN`), Google runs live: each person is a Gmail account of their own, with a refresh token from the same OAuth client (`CHANNELSTACK_GOOGLE_USER_<NAME>_TOKEN`). A person's email goes out through Gmail from their account; the agent's answers are read back from their mail.

Sent email can't be taken back. Live, every recipient must be an address in `CHANNELSTACK_LIVE_GOOGLE_ADDRESSES`, checked before Gmail is asked to send. A run labels every thread it touches with its tag, in the person's mailbox and in the agent's, and its session (or the sweep) trashes them.

| Feature | Fake | Live | How (live) | Notes |
|---|---|---|---|---|
| `google.createUser({ name, address, token })` | Done | Built | The person's own account's refresh token; their address is the account's | A person is their mailbox: their `id` is their address. In the fake, `<name>@example.com` |
| `ana.send({ to, cc, subject, text, html })` | Done | Built | `users.messages.send` with the person's token, labelled with the run's tag | To the agent's address a copy lands in the agent's inbox, unread, and its watch hears of it. Attachments aren't built, fake or live |
| `ana.reply(email, { text, all })` | Done | Built | `users.messages.send` on the person's thread, with `In-Reply-To` and `References` | `Re:` its subject, to its sender (`Reply-To` first), and with `all` to everyone on it |
| `ana.inbox()`, `waitForEmail` | Done | Built | `users.messages.list` and `get` in the person's mailbox | Read again before each read (cached for a second) |
| `thread.messages()`, `replies()`, `transcript()`, `toHaveReplyFrom` | Done | Built | Each person's mail | A thread is the emails joined by `In-Reply-To` and `References`. In the agent's mailbox, Gmail threads them by `threadId`, references and a matching subject. An email's `labels` are its copy's there (`INBOX`, `UNREAD`, `SENT`, the agent's own): live, empty, since a test doesn't read the agent's mailbox |
| The agent's API (`users.messages`, `threads`, `labels`, `history.list`, `watch`, `stop`, `getProfile`) and Google's token endpoint | Done | Agent's concern | — | The fake answers as Gmail's discovery document says (exit check 9.2), with Google's error envelope; the token endpoint takes the `refresh_token` grant only. `googleapis` needs `rootUrl` per API, and `{ raw }` for `messages.send`: its media upload ignores `rootUrl` |
| Push deliveries (`gmail.history`) | Done | Agent's concern | — | Pub/Sub pushes to the agent's own URL. The fake pushes in Pub/Sub's wrapped format with an RS256 OIDC token for the push endpoint, from a per-install key whose certificates it serves, at most once a second per mailbox and session ([decision 0022](decisions/0022-gmail-push-rate.md)), retried on Pub/Sub's backoff |
| `delivery.resend()` / redelivery | Done | No | — | Fake-only. Pub/Sub pushes again only what wasn't acknowledged |
| `google.calls()`, `waitForCall`, `toHaveReceivedCall` | Done | Yes, with proxy | Proxy mode | Gmail doesn't report the mailbox's calls |

---

## What this means for test authors

1. **Most of a test runs live with plain tokens.** Commenting, reviewing, delegating and every read work on all four platforms through a person's token, including Notion, now that it has personal access tokens. Slack is the exception for messages: one posted through the API carries the posting app's bot, so a person's `say` and `reply` are typed in the client by the browser actor.
2. **The UI-only actions** are:
   - Slack: a person's messages (`say`, `reply`), clicks, modals, slash commands, Stop and the agent split view.
   - GitHub: the requested-action buttons on check runs. (Re-run is not yet supported live.)
   - Linear: Stop.
   - Notion: adding connections. (Resolving discussions is not yet supported live.)

   They need the browser actor live, with a saved session ([Browser sessions](#browser-sessions)). It is built for Slack's `say`, `reply` and `click`; the others report `action_requires` live, and the framework skips the step.
3. **Live mode acts and observes; it never relays.** channelstack acts on the real platform and reads the results back to check that the agent reacted. The platform delivers events to the agent directly; delivery chaos (retries, bad signatures, redelivery) is fake-only. On GitHub, the App's delivery log still lets tests read what was delivered to the agent ([live-mode.md](live-mode.md)).
4. **Agent-side visibility works live only through proxy.** That covers API calls, the status line, streams, ephemeral messages and faults.
5. **A live run without a piece a step needs skips that step and says why,** instead of failing (`action_requires`, `unsupported_in_live`). The fake run never skips.

Some things are fake-only: fixed user ids, Slack Connect channels, uninstall and reinstall in every run, and `channelstack.reset()`. Tests that rely on them still run on every PR. The coverage page lists them as fake-only.

## Browser sessions

The browser actor never signs in itself, and never handles a password. Each sandbox person is created once by the sandbox owner (no platform has an API for that), and signs in by hand once:

- **`channelstack login slack --user ana`** opens a browser window at the sandbox's sign-in page. Once Ana is in, channelstack saves the session's cookies (`<home>/browser/slack-ana.json`, 0600; `--save <path>` writes a copy, e.g. for a CI secret). The browser actor uses that session, or the one `createUser({ browser: { storageState } })` names.
- **Sign in rarely.** Set a long session duration in the sandbox. `channelstack doctor` says whether each saved session is still signed in; when one has expired, the person runs `channelstack login` again.
- **Without a saved session,** a browser row reports `action_requires` live and the framework skips the step; the fake run is unaffected. channelstack never tries to solve a CAPTCHA.

The browser actor is built for Slack. The browser rows of GitHub, Linear and Notion aren't built yet and report `action_requires` live.

## Still to confirm in the first live spike

Answered so far (2026-11-23, Slack sandbox):

- **V1, Slack A2: not possible through the API; blocked on the browser actor.** channelstack's side works against real Slack: the tagged channel, the invite, reading the thread back, and cleanup (the sweep check found nothing left). But Slack marks every message posted through its API with the posting app's `bot_id` and `app_id`, a person's user token included, whichever app issued it (a separate app for the sandbox's people was tried) and with `as_user=true` too. The reference agent, most agents and `slackChecks()` ("ignores other bots") drop such a message, so no API post of a person's reaches the agent. A person's message needs Slack's client: live `say` and `reply` go through the browser actor. **Answered 2026-11-24:** the browser actor types the message in Slack's client, the real agent replies, and the reply is read back (about 7 seconds from Chrome's start to the typed message, then the agent's time).
- **A DM with an app in Slack's agent view is one long thread.** With the app's agent view on, the DM has a root message ("New Assistant Thread", subtype `assistant_app_thread`) and every exchange is a reply under it, shown in the main pane with no thread pane. The live world reads a typed DM message back from those replies too, the browser actor uses the conversation's composer and buttons there, and cleanup deletes the session's replies with the app's answers after each one (the root stays).
- **A real click reaches the agent (V4, 2026-11-24).** The browser actor finds the app's Approve button in the agent-view thread and clicks it; Slack sends the agent `block_actions`, and its "deploying" answer is read back from the thread. The reference agent lets only workspace admins approve and answers anyone else ephemerally, which no API reads back, so the example asks for an admin: live, `createUser` refuses an `admin`, `owner` or `guest` option the real account doesn't match (`live_misconfigured`). Stop isn't built yet.
- **Slack's read methods ignore a JSON body.** `users.info` answers `user_not_found` to one; the live client sends parameters form-encoded, as Slack's SDK does.

- **Linear opens an agent session only while the app's webhook reaches a running agent.** A person's key creates the team and the issue and sets the delegate. With the webhook reaching no agent (2026-11-23), Linear opened no session, and the live backend says so after 15 seconds (`no_agent_session`). With the webhook at a relay channel the live run forwards to the reference agent (2026-11-24), the session opens within seconds and the live example passes.
- **Linear refuses a query that is too complex** (over 10,000 points): every agent session with its activities in one query is. The live backend lists the app's sessions by id and reads each one on its own.

Still open:

1. **Slack:** does `conversations.replies` show partial text while a message streams?
2. **GitHub:** are App bots refused as assignees and reviewers? The fake accepts both, because the contract does; if GitHub refuses, the contract and the fake change together.
3. **Linear:**
   - Does an API reply (`commentCreate` with `parentId`) in a session send `prompted`?
   - Does an app's profile URL in a comment body open a session?
4. **Notion:** (answered against the sandbox: a comment made with a PAT is by the person, and it fires the integration's webhook, which the passing live example shows)
   - Does a page edit made with a person's PAT fire the integration's webhooks?
   - Does an in-body mention of an integration reach the agent?

5. **Browser sessions:** how long does a saved Slack session last with the longest session setting?

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
  - [Terms of Service: machine accounts](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
- **Linear:**
  - [Agents](https://linear.app/developers/agents)
  - [Agent interaction](https://linear.app/developers/agent-interaction)
  - [Agent signals](https://linear.app/developers/agent-signals)
  - [GraphQL schema](https://linear.app/developers/graphql)
- **Notion:**
  - [Personal access tokens](https://developers.notion.com/guides/connections-and-tokens/personal-access-tokens)
  - [Comment display name](https://developers.notion.com/reference/comment-display-name)
  - [Authorization](https://developers.notion.com/docs/authorization)
  - [Update a comment](https://developers.notion.com/reference/update-a-comment)
  - [Webhook events and delivery](https://developers.notion.com/reference/webhooks-events-delivery)
  - [Webhooks](https://developers.notion.com/reference/webhooks)
  - [MCP comment tools](https://developers.notion.com/guides/mcp/tools-comments-reference)
