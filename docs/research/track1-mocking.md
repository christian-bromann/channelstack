# Track 1: API mocking, service emulation, record/replay, contract testing

Researched 2026-11-19 for "channelstack" (e2e harness for Slack/GitHub/Linear agents).
Star counts come from `gh api repos/OWNER/REPO` on 2026-11-19. npm counts come from api.npmjs.org (last 30 days to 2026-11-18). PyPI counts come from pypistats.org (last month). Numbers from aggregators are marked **(unverified)**.

Legend:
- **Intercept**: how the app under test reaches the fake. *base-URL* = config swap; *in-proc* = patches the HTTP client inside the process; *proxy* = HTTP(S)_PROXY forward proxy with a MITM CA; *eBPF/sidecar* = kernel or network-level capture.
- **State**: whether the fake keeps state across requests.
- **Inbound**: whether the fake calls *your* app (webhooks or callbacks).
- **Spec fidelity**: whether the fake is validated against a machine-readable provider spec.

## 1. The direct overlap: vercel-labs/emulate

- Repo: https://github.com/vercel-labs/emulate. Apache-2.0. **1,997 stars**. Created 2026-03-20. Latest release **v0.14.0 on 2026-11-18** (v0.13.1 on 11-08, v0.13.0 on 10-29). Badged as a "Vercel Labs experiment". Site: https://emulate.dev
- npm `emulate`: 1.81M downloads Nov 1-18 2026 and 2.54M for the 30 days to 11-18. The trend is steep: 7.7k in Mar, 141k in May, 679k in Aug, 1.62M in Oct. Caveat: the package name has version history back to 2016, so a small part may be legacy. CI re-installs also inflate the figure.
- Tagline: "Fully stateful, production-fidelity API emulation. Not mocks."
- **Providers (15):** Vercel, GitHub, Google, Slack, Apple, Microsoft, Okta, AWS, Resend, Stripe, MongoDB Atlas, Clerk, **Linear**, Twilio, and "AI" (OpenAI Responses/Chat plus Anthropic Messages, deterministic and rule-driven, with streaming, faults and stalls). Packages live under `packages/@emulators/*`, plus Next and Nuxt adapters.
- **Intercept: base-URL swap.** Each service gets a localhost port (GitHub 4001, Slack 4003, Linear 4012, and so on). There are `--base-url` / `EMULATE_BASE_URL` overrides with `{service}` templating. HTTPS comes through Vercel's `portless` reverse proxy (`https://github.emulate.localhost`). Framework adapters mount emulators inside Next/Nuxt routes. **No HTTPS_PROXY/CA interception:** a code search of the repo for `HTTPS_PROXY` returned 0 hits.
- **Plugin API:** `defineEmulator({ name, state: () => ({...}), setup({ app, state }) { app.get(...) } })` (Hono-style handlers), `createEmulator({ service, port })`, and `defineConfig({ services: {...} })`. It has seeds, `reset()`, opt-in persisted snapshots, `port: 0` / `listen: false`, an `init` scaffold, and a web inspector for requests and state.
- **State:** yes, in-memory stores per service with seed and reset.
- **Inbound simulation, already strong for our three providers:**
  - **GitHub:** repo and org webhooks with CRUD, ping, test and `deliveries`. Real HTTP delivery on all state changes. GitHub App JWT and installation tokens with permission enforcement. App webhooks include `installation` and are signed with `X-Hub-Signature-256`. Check runs carry App attribution.
  - **Slack:** signed `event_callback` (v0 HMAC) on write state changes. `app_mention` and multi-app envelopes. **Interactivity:** signed button-action and modal-submission callbacks to `interactivity_url`, with single-use `trigger_id` and the 3-second ack semantics. `POST /_slack/simulate/event-retry` sends `X-Slack-Retry-Num` and `Retry-Reason`, which is our "redeliver". `apps.uninstall` produces `app_uninstalled` and `tokens_revoked`. There is an OAuth v2 install flow with a user picker UI.
  - **Linear:** stateful GraphQL with signed `Linear-Signature` webhooks. **Agent Interaction API:** `agentSessionCreateOn*`, `agentActivityCreate`, and `AgentSessionEvent` `created`/`prompted` webhooks. A human token can post `prompt` activities.
  - **Twilio:** `/_twilio/simulate/inbound-*` routes.
- **Stated gaps (from the README):**
  - Slack: **"chat streaming"**, Socket Mode, slash commands, shortcuts, non-button interactions, `view_closed`, workflows, canvases, lists, exact rate limits.
  - Linear: "full schema coverage", **"session dismissal by users"** (that is our "press Stop"), routing AgentSessionEvent to the owning app only.
  - GitHub: webhook redelivery is not explicitly documented **(unverified)**.
- **Spec fidelity:** **none found.**
  - Routes are hand-written.
  - The "contract" tests are client-SDK compatibility tests (the real `openai`, `ai`, and `@ai-sdk/*` SDKs against the AI emulator), plus `tests/contracts/{custom-api,github-app-identity}`.
  - A code search for `openapi` in the repo returned 0. No use of GitHub's REST OpenAPI, `@octokit/webhooks` schemas, or Linear introspection was found. No re-record job: CI is `ci.yml` and `release.yml` only.
  - Caveat: GitHub code search may not index everything, so this is "not found", not "proven absent".
- **Rendered-conversation assertions:** the inspector shows state, but there is no assertion API on a human-visible transcript (streams, status, edits).
- Pricing: free and OSS. No commercial tier.

**Implication:** emulate already covers stateful GitHub/Slack/Linear fakes, signed webhooks, button clicks, event retries, app uninstall and Linear agent sessions. Channelstack's fakes are **not novel per se**. Its differentiators against emulate would be:
- proxy interception, so no base-URL plumbing and SDK hosts are hard-coded;
- spec- and recording-checked fidelity with a nightly re-record;
- Slack streaming, assistant status, Stop and Linear dismissal;
- human-view conversation assertions.

Contributing to or building on emulate via `defineEmulator` is a real option to weigh.

## 2. Business-model precedent: LocalStack (OSS, then paid)

- Repo https://github.com/localstack/localstack: **65,109 stars, archived (read-only)**. Last push 2026-03-23. The README says the repo is archived in favour of the "Unified LocalStack Image".
- Timeline:
  - 2017 OSS (originally from Atlassian).
  - $3M seed (CRV, Heavybit).
  - **$25M Series A on 2024-11-12, led by Notable Capital** (https://techcrunch.com/2024/11/12/localstack-raises-25m-to-help-developers-emulate-and-test-cloud-apps-locally/).
  - **2025-12-18 "The Road Ahead"** (updated 2026-03-17, https://blog.localstack.cloud/the-road-ahead-for-localstack/): in March 2026 Community and Pro merge into one image that **requires an auth token**. The Community `latest` tag goes away and pinned old tags get no security patches. Third-party posts report the `LS_ACKNOWLEDGE_ACCOUNT_REQUIREMENT` bypass ended 2026-04-06 **(unverified)**.
- Pricing (https://www.localstack.cloud/pricing, fetched 2026-11-19):

  | Plan | Price |
  |---|---|
  | Hobby | Free, **non-commercial only** |
  | Base | $39/user/mo annual, $45 monthly |
  | Ultimate | $89/user/mo annual |
  | Enterprise | Custom |

  CI credits no longer differentiate plans.
- Backlash and fallout: forks and alternatives appeared. **hectorvent/floci has 31,970 stars** (created 2026-02-18), and LocalEmu is another. Many "LocalStack killed its free tier" posts appeared on dev.to.
- Model: an OSS emulator of a huge API surface, a paid tier for the long tail of services and advanced features (persistence, chaos, CI analytics, IAM enforcement), and finally a gate on all commercial use.
- Lesson for channelstack:
  - The "fidelity of a big third-party API" pitch is fundable.
  - Closing the core alienates the community and spawns forks quickly.
  - If you monetize, keep the fakes open and charge for hosted, recorded-fidelity and collaboration features.

## 3. Tool-by-tool

| Tool | What | Intercept | State | Inbound (calls you) | Spec fidelity | Adoption | Money / pricing |
|---|---|---|---|---|---|---|---|
| **WireMock** (OSS) | Java HTTP stub server: request matching, templating, record/playback, "scenarios" (finite-state) | base-URL; also works as a forward **proxy with HTTPS (browser-proxying + CA)** | Scenario state machine only | **Webhooks/callbacks extension** (post-serve outbound HTTP) | No (OSS) | 7,429 stars; npm `wiremock` 98k/mo | Apache-2.0 |
| **WireMock Cloud** (WireMock Inc.) | Hosted mocks, OpenAPI import, stateful mocking, MCP server (Apr 2025), remote MCP | base-URL (hosted) | Yes | Webhooks | Imports/generates from OpenAPI; drift features **(unverified)** | — | **$6.5M seed, 2023-05-24** (https://tech.eu/2023/05/24/wiremock-raises-65-million-in-seed-funding-for-groundbreaking-api-developer-productivity-platform-wiremock-cloud/). Free tier 1 user / 1k calls / 3 mocks **(unverified, third-party)** |
| **Mockoon** | Desktop/CLI mock designer; OpenAPI import; "data buckets" CRUD; proxy forward mode; callbacks | base-URL (plus forward-to-real proxy) | CRUD data buckets | **Callbacks** (outbound HTTP after a response) | Imports OpenAPI; no validation | 8,494 stars; `@mockoon/cli` 312k/mo | MIT. Mockoon Cloud from ~$15/mo solo, team ~$100/mo **(unverified, aggregators)** |
| **Stoplight Prism** | OpenAPI mock server **and validation proxy** (validates live req/resp against spec) | base-URL; proxy mode forwards to the real upstream | No | No | **Yes: OpenAPI-driven responses plus runtime spec validation** | 5,072 stars; `@stoplight/prism-cli` 1.43M/mo | Apache-2.0. Stoplight **acquired by SmartBear, announced 2023-08-22** |
| **Microcks** | Spec-to-mock for OpenAPI, AsyncAPI, gRPC, GraphQL, Postman, SoapUI; **conformance tests** of real implementations against specs | base-URL; async mocks publish to Kafka/MQTT/WS | Limited (templated; stateful mocks added in 1.10, **unverified**) | Async (publishes events to brokers); HTTP webhooks not confirmed | **Yes: mocks from spec plus conformance scoring of real APIs** | 2,089 stars; **CNCF Incubating 2026-05-07** (https://www.cncf.io/blog/2026/05/07/microcks-becomes-a-cncf-incubating-project/), Sandbox 2023-06 | Apache-2.0; Postman-affiliated maintainers |
| **Hoverfly** | Go service-virtualization proxy: capture / simulate / spy / modify / synthesize / diff modes | **Forward proxy with HTTPS_PROXY plus its own CA**, or webserver mode | Yes ("state" keys in simulations, sequences) | Post-serve actions (outbound callbacks) | No (diff mode compares simulation vs real) | 2,534 stars | Apache-2.0. **Hoverfly Cloud acquired by iOCO** from SpectoLabs (https://ioco.tech/?p=76640, date not confirmed) |
| **mountebank** | Multi-protocol "imposters" (HTTP/S, TCP, SMTP); proxy imposters record and replay | base-URL (imposter ports); proxy-to-real for recording | Via JS injection | No native | No | 2,108 stars (moved to `mountebank-testing` org); npm 136k/mo | MIT, community-maintained |
| **MSW** | In-process request interception (Service Worker in browser; `@mswjs/interceptors` patches http/fetch in Node) | **in-proc** | No (pair with `@mswjs/data`, 692k/mo) | No | No (community OpenAPI-to-handlers generators exist) | 18,356 stars; npm `msw` **139M/mo**, interceptors 147M/mo | MIT, OpenCollective-funded |
| **Polly.js** (Netflix) | Record/replay HAR for browser and Node | in-proc adapters (fetch, XHR, node-http) | No | No | No | 10,250 stars; last push 2025-05-31 (dormant, not archived); `@pollyjs/core` 1.04M/mo | Apache-2.0 |
| **nock** | Node HTTP mocking plus recorder | in-proc (patches `http`; fetch support) | No | No | No | 13,142 stars; 35.8M/mo | MIT |
| **VCR.py / pytest-recording** (also Ruby VCR, Python `responses`) | Cassette record/replay of HTTP | in-proc (patches requests, httpx, aiohttp, ...) | No | No | No (re-record via `--record-mode`) | vcrpy 3,024 stars, 17.4M/mo; pytest-recording 616 stars, 5.4M/mo; Ruby vcr 6,079 stars; responses 4,342 stars, 71.5M/mo | MIT |
| **Keploy** | Records real traffic into tests plus dependency mocks; AI test generation | **eBPF** (no code changes, no base-URL) | Replays recorded sequences | No | No (recorded-truth fidelity) | **19,888 stars**; $1.3M seed 2022 (Chiratae) **(unverified, CB Insights)** | Apache-2.0 OSS plus Keploy Cloud/Enterprise |
| **Speedscale / proxymock** | k8s traffic capture and replay, service mocks, load; free local `proxymock` CLI with MCP | sidecar/eBPF in k8s; proxymock runs a local recording proxy (mechanism not documented on the page I read) | Replayed | No | Generates from OpenAPI/proto when there is no traffic | ~$9-12.8M raised, YC **(unverified, aggregators)** | proxymock free; Pro/Enterprise paid |
| **Specmatic** | Executable contracts: the OpenAPI spec becomes contract tests plus a stub ("service virtualization"); backward-compat checks; MCP server | base-URL stub | Limited | No (AsyncAPI is Enterprise) | **Yes: spec-as-contract, both directions** | 401 stars | MIT OSS; Enterprise ~$50/user/mo **(unverified)** |
| **Pact / PactFlow** | Consumer-driven contracts (HTTP plus "message pacts"); PactFlow bi-directional mode checks pacts against provider OpenAPI | in-test mock server (base-URL) | Provider states | Message pacts model async events; no real delivery | **Bi-directional: consumer pacts vs provider OpenAPI** | pact-js 1,827 stars, 4.26M/mo; pact-jvm 1,146 stars | OSS; **PactFlow acquired by SmartBear, announced 2022-04-05** |
| **mitmproxy** | Interactive TLS-intercepting proxy, Python addons; `mitmproxy2swagger` derives OpenAPI from traffic | **proxy with HTTPS_PROXY plus CA** (also transparent and WireGuard modes) | Whatever addons implement | Addons can initiate requests | No | **47,096 stars**; PyPI 4.13M/mo | MIT |
| **MockServer** (mock-server.com) | Java mock plus proxy; expectations, callbacks; AI/MCP features | **forward proxy with HTTPS_PROXY plus its CA**, or base-URL | Limited | Callbacks (class/closure) | OpenAPI expectations | 5,010 stars | Apache-2.0 |
| **Beeceptor** | Hosted mock endpoints; AI spec-to-mock (listed Jan 2026, **unverified**); CRUD; **drift detection** of traffic vs spec | base-URL; forward proxy (Scale plan only) | CRUD objects | Webhook testing tool (plan coverage unstated) | **Drift: validates proxied traffic vs OpenAPI, AI proposes spec patch** | — | Free 50 req/day; $10 / $25 / $99 per mo (https://beeceptor.com/pricing/) |
| **Mockaroo-type** (Mockaroo, Faker) | Fake data generators, not API fakes | n/a | n/a | n/a | n/a | — | Mockaroo free 200 rows/req, paid ~$60-$500/yr **(unverified)** |
| **Optic** | OpenAPI diff/lint in CI; traffic-based spec updates | proxy/capture | — | — | Spec drift | **Acquired by Atlassian, Apr 2024** (https://www.atlassian.com/blog/announcements/optic-acquisition) | — |
| **Akita** | API discovery and spec inference from traffic (eBPF/pcap) | passive capture | — | — | Traffic-to-model | **Acquired by Postman 2023-07-19** | — |

## 4. AI-era newcomers (2025-2026)

- **StrongDM "Digital Twin Universe"** (Feb 2026, https://factory.strongdm.ai/techniques/dtu; write-up at https://simonwillison.net/2026/feb/7/software-factory/):
  - Agent-built behavioral clones of **Okta, Jira, Slack**, Google Docs, Drive and Sheets, used as test beds for agent-written software.
  - Validated "against the live dependency until we stop finding behavioral differences." That is the closest precedent for "fidelity checked against the real provider".
  - Internal, not OSS. Interception method not stated.
- **emulate's AI service** (above): deterministic fake LLM endpoints with streaming faults.
- **WireMock MCP** (Apr 2025), **Specmatic MCP**, **Microcks MCP roadmap**, **Beeceptor MCP**, **Speedscale proxymock MCP**, **MockServer MCP**: incumbents bolting agent control onto mock servers.
- Small OSS: **Mimikos** (OpenAPI to deterministic mock, Show HN), **mockloop-mcp** (spec-to-mock via MCP, PyPI), **llemulator** (fake OpenAI).
- An extended search for an LLM-generated *stateful SaaS emulator from specs* found no established OSS project beyond these.

## 5. What is NOT novel for channelstack

**Proxy interception (HTTPS_PROXY plus CA): long-established.** It exists in:
- Hoverfly: designed around exactly this, with simulate/capture modes and state;
- mitmproxy: scriptable, 47k stars;
- MockServer;
- WireMock: browser-proxying;
- Beeceptor: forward proxy;
- Speedscale/Keploy: capture at the sidecar or eBPF level instead.

What is new is combining proxy routing with **stateful, provider-specific fakes** of Slack/GitHub/Linear. emulate does the fakes but only via base-URL; Hoverfly and mitmproxy do the proxy but have no provider semantics.

**Spec-checked fidelity: exists generically, not for these providers.**
- Prism validates traffic against OpenAPI.
- Microcks runs conformance tests of an implementation against a spec.
- Specmatic and PactFlow (bi-directional) check contracts against OpenAPI.
- Beeceptor and Optic do traffic-vs-spec drift.
- StrongDM validates twins against live services (internal).

None of them ships a **GitHub/Slack/Linear fake validated against GitHub's REST OpenAPI, `@octokit/webhooks` schemas, or Linear introspection, with nightly re-recording of real Slack traffic**. emulate, the closest product, has no spec validation that I could find. Using Prism or Microcks-style validation *of the fake itself* in CI is a known technique, but no one has packaged it for these providers.

**Record/replay with re-record:** commodity (VCR, Polly, nock, Keploy, Speedscale, Hoverfly capture). A nightly re-record *to detect provider drift and fail the fake's own tests* is the less common part.

**Scripted human actors emitting signed webhooks:** emulate already signs GitHub, Slack and Linear webhooks and simulates button clicks, modal submits, event retries, uninstall and Linear prompts. That is **not novel versus emulate**. Gaps remain for streaming, Stop/dismiss, slash commands, shortcuts and Socket Mode.

**Assertions on the rendered conversation as a human sees it** (stream chunks collapsed, status lines, edits and deletes as the final view): **no tool in this track does this.** All of them assert on HTTP requests and responses or stored state. This appears to be the clearest open space.
