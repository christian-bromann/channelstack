# Phase 6 plan

Proxy mode and conformance ([phases.md](../../docs/phases.md#phase-6-proxy-mode-and-conformance), [implementation-plan.md](../../docs/implementation-plan.md) 6.2 and 9, [live-mode.md](../../docs/live-mode.md) 6).

## What this PR can and can't finish

Proxy mode, the CA, the Go agent and the conformance tooling need no new credentials. The differential run and the internal receivers need the four sandboxes, which exist since phase 5, and the nightly job, which runs only once its workflow is on `main`. Docker runs in CI (Linux); locally, only when Docker Desktop is running.

| Exit check | In this PR | Needs `main` or the maintainer |
|---|---|---|
| 6.1 No code changes needed | Done here: an acceptance test runs the phase 1 Slack examples against the Bolt reference agent with no `SLACK_API_URL`, through the proxy | — |
| 6.2 Go works through Docker | A Go reference agent (`slack-go`), its image, and an acceptance test that runs it in Docker against the proxy; CI runs it on Linux | — |
| 6.3 The CA is contained | Done here: unit tests with a real TLS handshake | — |
| 6.4 Differential run | The scenarios, the runner that compares fake and live, `conformance/divergences.yaml` and its check, the nightly job; a local run against the sandboxes, with each difference fixed or recorded | The nightly job's first run on `main` |
| 6.5 Coverage page | Generated from the capabilities, the divergences and the nightly results, and published by CI (an artifact on every run, and the job summary) | — |

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 6.1 | `test/acceptance/proxy/slack-proxy.test.ts`: the phase 1 Slack examples' agent steps against `examples/agents/bolt-ai-sdk` with only what `channelstack env --proxy` prints | new `server/src/core/proxy/`, `server/src/core/ca/`, `app.ts` (provider hosts), `serve.ts` (the proxy listener), `cli.ts` (`--proxy`, `env --proxy`, `ca rotate`), each driver's `hosts`, `scripts/lib/stack.ts` (`proxy: true`) |
| 6.2 | `test/acceptance/proxy/go-docker.test.ts` (skipped, with the reason, where Docker isn't running; CI's Linux job requires it) | new `examples/agents/go-slack/` (`main.go`, `Dockerfile`) |
| 6.3 | `server/src/core/ca/ca.test.ts`: a certificate for a host outside the routed list, signed by the CA, fails a real TLS handshake on the name constraints; the CA refuses to issue one; its files are 0600 under `<home>/ca/`; nothing writes to a system trust store | `core/ca/` |
| 6.4 | `conformance/conformance.test.ts` (normalizing, diffing, divergences with a reason and an expiry, an expired one fails); `pnpm conformance` against the sandboxes; `.github/workflows/live.yml` (nightly) | new `conformance/` (runner, normalizer, `divergences.yaml`), `scenarios/<driver>/*.yaml`, the recorder in `core/proxy` (live pass-through), the shape differ |
| 6.5 | `conformance/coverage.test.ts` (the page from a fixed set of inputs); the `coverage` step in CI uploads it | new `conformance/coverage.ts` |

## Design in one paragraph

`channelstack start --proxy` also listens on a loopback proxy port (`--proxy-port`, default 7464). A `CONNECT` to a routed host (`slack.com`, `files.slack.com`, `api.github.com`, `api.linear.app`, `api.notion.com`) is piped to an internal TLS listener whose certificate is issued by channelstack's own CA for exactly those hosts, and the request is served by the same fake that `*.localhost` serves (provider hosts are added to the app's host routing). In live mode, the same listener forwards each request to the real host, and records the exchange, redacted, as a cassette. Every other host is tunnelled through untouched. With `--proxy`, a driver's own URLs (Socket Mode's WebSocket, upload URLs, `response_url`) use the provider's host too, so an agent that can only reach the proxy reaches them through it. The CA is generated once per install in `<home>/ca/` (0600), name-constrained to the routed hosts, and never added to a system store: `channelstack env --proxy` prints `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY=1`, `NODE_EXTRA_CA_CERTS`, and `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` pointing at a bundle of the public roots plus the CA, instead of the API URLs. Conformance runs each scenario in `scenarios/<driver>/` against the fake and against the sandbox with the same reference agent, normalizes the transcripts and event sequences (ids, timestamps and URLs dropped), and fails on a difference unless `conformance/divergences.yaml` lists it with a reason and an unexpired date.

## Reuse

| Concern | Module |
|---|---|
| Host routing to a fake | `app.ts` `byHost`, extended with each driver's provider hosts |
| Private files under the state directory | `core/home` (`writePrivateFile`, `readPrivateJsonFile`) |
| Redacting recordings | `core/redact` (`Redactor`) |
| Polling and time | `core/clock` (`pollUntil`, the injected clock) |
| The agent's environment | the `/env` control route and `channelstack env`, with a `proxy` option |
| Starting a server with an agent | `scripts/lib/stack.ts` `withStack`, with `proxy: true` |
| The live run with every agent | `scripts/lib/live-agents.ts`, `scripts/live.ts` |
| Scenario files | the smoke scenario format (decision 0002) and its TypeScript runner |
| Capabilities | each route's `live` declaration (`x-channelstack-live`) and the reality matrix |
| The real platforms' webhooks | GitHub's delivery log (`github.deliveries()`), the relay channels `pnpm live` already forwards |
| New: `core/ca/` | Nothing issues certificates yet: portless's CA is portless's |
| New: `core/proxy/` | Nothing proxies yet |
| New: `conformance/` | The differential run is channelstack's own CI, not a user feature (live-mode.md 6) |

## New dependencies

| Package | Version | Why a library and not our code | License | Maintained |
|---|---|---|---|---|
| `@peculiar/x509` (server) | to pin on install | X.509 certificates over WebCrypto: the CA, its name constraints, and the leaf certificates. Pure TypeScript, no native code, so it compiles into the binary | MIT | Yes |
| `github.com/slack-go/slack` (Go reference agent) | to pin in `go.mod` | The Go community's Slack client, so the Go agent is what a Go team would write | BSD-2-Clause | Yes |

## Docs to update

- `docs/architecture.md` (proxy)
- `docs/devx.md` section 9
- `docs/reality-matrix.md`
- `docs/code-map.md` (`core/ca`, `core/proxy`, `conformance/`, the Go agent)
- A decision: `docs/decisions/0016-proxy-mode.md`
