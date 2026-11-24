# 0016: Proxy mode and conformance

Status: accepted, phase 6.

## Proxy mode

`channelstack start --proxy` also listens on a loopback HTTP proxy (`--proxy-port`, default 7464, fixed so the `HTTPS_PROXY` line in an agent's `.env` stays right across restarts). It is for agents that hard-code their platform's host, or run on stacks whose base URL can't be changed (implementation plan 6.2).

- **Routing.** A `CONNECT` to a routed host goes to a TLS listener inside the server, and the same fake that `*.localhost` serves answers it. The hosts are each driver's `hosts`: `slack.com`, `api.github.com`, `api.linear.app`, `api.notion.com`. Every other `CONNECT` is a plain tunnel to that host. Plain HTTP to a routed host is refused (`403`), since the platforms are HTTPS only.
- **One world.** The proxy doesn't tell sessions apart: an agent's call reaches the fake as it would through `*.localhost`.
- **The fakes' own URLs.** With `--proxy`, a driver's URLs are the provider's origin: `wss://slack.com/link` for Socket Mode, upload URLs, `response_url`. An agent that reaches the platform only through the proxy reaches those too. So a server is in proxy mode or base-URL mode, not both.
- **Live.** A routed call of a live driver's agent goes on to the real platform (`forward`). channelstack is in the path only so the call can be recorded. Live operations that would read the agent's calls back (`calls()`, Slack's status and ephemeral messages) still need that read-back: they are refused, and the message says so ([#24](https://github.com/christian-bromann/channelstack/issues/24)).

### The CA

channelstack has its own CA for proxy mode, separate from portless's.

- **Where.** It is made once per install in `<home>/ca/` (0600, in a 0700 directory).
- **Name-constrained.** It may vouch only for the routed hosts, and for no IP address at all. A certificate it signs for any other name fails verification, whoever made it (exit check 6.3 proves this with a real TLS handshake).
- **Issuing.** A leaf certificate for the routed hosts is made at each start and kept in memory.
- **Rotation.** The CA is replaced when it is about to expire, or when the routed hosts change. `channelstack ca rotate` replaces it on demand.
- **Trust.** It is never added to a system trust store. Only the agent's environment trusts it: `channelstack env --proxy` prints `NODE_EXTRA_CA_CERTS` (the CA), and `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE`, a bundle of the public roots and the CA, for runtimes that replace their bundle.

### Node agents and undici

With `NODE_USE_ENV_PROXY=1`, Node 24's `fetch` uses `HTTPS_PROXY`. But importing the `undici` package installs its own global dispatcher, which replaces Node's proxy-aware one. Bolt does this through `@slack/socket-mode`. The latest undici, 8.13, still does it.

So an unmodified Bolt app calls slack.com directly, even with the proxy set. undici installs its dispatcher only where it can define its global. `env --proxy` therefore also prints `NODE_OPTIONS=--import=<home>/proxy/node-env-proxy.mjs`, a preload that defines that global first, empty and fixed. undici then keeps its Agent to itself, and Node's `fetch` keeps the proxy. `core/proxy/node.test.ts` proves both directions against the undici Bolt loads.

### Go

Go on macOS ignores `SSL_CERT_FILE`, so a Go agent runs in Docker for proxy mode (exit check 6.2). The container shares the host's network, so the proxy's loopback address works as it is, and the bundle is mounted. `examples/agents/go-slack` is the reference agent, written with `slack-go`.

## Conformance

The differential run (implementation plan 9) is channelstack's own CI, not a user feature. It needs the sandboxes, so it runs nightly. CI runs its scenarios against the fakes on every pull request.

- **Scenarios.** They live in `scenarios/<channel>/*.yaml`, in the smoke scenario format (decision 0002) with two additions:
  - a call may name a handle inside a variable (`message.thread.waitForReply`);
  - a `record` step saves values by name, which the TypeScript runner writes with `--record`. Callable members and secrets are left out.
- **Comparing.** `pnpm conformance` runs each scenario against the fake with the channel's reference agent, and against the sandbox with the same agent (`lib/live-stack.ts`, shared with `pnpm live`). Both recordings are normalized: ids, times, links, mentions, account names and secrets are dropped or replaced, and structure, order and text are kept. Then they are diffed by path.
- **Recording.** Both runs go through the proxy with the recorder (`start --proxy --record <dir>`), and each live relay is tapped. So the platform's real API answers and webhooks, and the fake's, are written as shapes: structure and types only, with codes like `ok`, `error` and `type` kept.
- **The shape differ.** For each operation both sides saw, it reports what the platform sends that the fake doesn't, and types with nothing in common. Keys only the fake has aren't reported, since the platform leaves out optional fields its data doesn't have. Refusals (`ok: false`, a GraphQL answer with `errors`) aren't compared.
- **Divergences.** A difference fails the run unless `conformance/divergences.yaml` lists it, with a reason and a date it expires. An expired entry fails again, and so does the unit test that checks the file.
- **Coverage page.** `pnpm coverage` makes it from the spec's capabilities (`x-channelstack-live`), the divergences and a run's results. CI uploads it with every run, with a summary on the job. The nightly job makes it with that night's results.

### What the first runs found

- **GitHub:** the fake made test repositories private and live made them public. Now one default (`PRIVATE_BY_DEFAULT`) serves both, and it is private.
- **Linear:** real Linear records the delegating person's prompt, "Work on [KEY-1](url)", as a session's first activity. The fake now does too.
- **Notion:** every answer of Notion's carries a `request_id`. The fake's now do too.
- **Recorded, with issues:** fields GitHub's, Linear's and Notion's payloads have that the fakes don't send yet ([#25](https://github.com/christian-bromann/channelstack/issues/25), [#26](https://github.com/christian-bromann/channelstack/issues/26), [#27](https://github.com/christian-bromann/channelstack/issues/27)). Also recorded: Notion's `page.created` for a seeded page made by a real person.

## Alternatives considered

- **An MITM library (`http-mitm-proxy`, `mockttp`) instead of our own `CONNECT` handling.** Rejected:
  - they need a CA of their own, which can't be name-constrained the way 6.3 asks;
  - TLS termination inside them doesn't run under Bun's compiled binary.

  Our proxy only pipes bytes to a TLS listener Bun already serves.
- **Wrapping the client socket in a server-side `TLSSocket`.** Rejected: Bun's support for that is incomplete, while `Bun.serve` with a certificate is solid.
- **Recording whole exchanges as cassettes.** Rejected for now: a cassette holds tokens, emails and text, which would need redaction to be right every time. A shape holds none of it, and is all the shape differ needs.
- **Asking agents to drop undici, or to pass a proxy agent.** Rejected: 6.1 says no code changes. The preload is environment only, and only in the agent's environment.
