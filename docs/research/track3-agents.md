# Track 3: AI-agent simulation, evaluation and environment companies

Research date: 2026-11-19. "(unverified)" = only secondary/aggregator source, or conflicting sources. GitHub stars and npm downloads pulled live via `gh api` / npm API on 2026-11-19.

Key for channelstack overlap:
- **Sim target**: LLM/user (simulated human talking to the agent) vs. ENV (fake third-party app the agent calls).
- **Real channel path**: does it push signed platform events (Slack Events API, GitHub webhooks, Linear webhooks) into the *deployed* agent so routing/ingress is exercised?

## TL;DR

1. **The single most important finding: `vercel-labs/emulate`** (Apache-2.0, ~2.0k stars, ~2.5M npm downloads/month, created 2026-03-20, Vercel Labs "experiment"). Stateful local emulators for **Slack, GitHub and Linear** (plus Vercel, Google, Stripe, Twilio, AWS, Okta, Clerk, Resend, an "AI" LLM stub...). It already does signed Slack `event_callback` delivery (`X-Slack-Signature`), Slack interactivity (buttons + modal submissions to your Interactivity URL), Slack event-retry simulation (`X-Slack-Retry-Num`), GitHub App webhooks with `X-Hub-Signature-256` and `installation` field, Check runs, **Linear webhooks with `Linear-Signature` and the Linear Agent Session API (`AgentSessionEvent` created/prompted, `agentActivityCreate`)**, strict-scope modes, seeds/reset, and an inspector. Integration is by **base-URL swap** (per-service ports, `--base-url`, portless HTTPS names), not transparent HTTPS interception. No scripted multi-actor scenario DSL, no assertions on the rendered conversation, no spec-conformance checking against real provider OpenAPI/recordings that I could find. Not implemented for Slack: Socket Mode, slash commands, shortcuts, chat streaming, rate limits, workflows. https://github.com/vercel-labs/emulate
   - This covers maybe 50-70% of channelstack's "stateful provider fakes" layer already, in OSS, with Vercel distribution. channelstack should treat it as **substrate/partner** (build on or contribute to it) rather than re-implement fakes, and differentiate on: HTTPS interception of unmodified deployed code, scripted human actors, conversation-level assertions, spec-checked fidelity, and the agent-platform-routing focus.
2. **A wave of commercial "SaaS twin" startups for app developers launched in 2026** (Hue YC F26, Arga Labs YC P26 $10M seed, Drizz twins, StateWeave, Pome, Archal, WonderTwin -> acquired by LocalStack). They sell Slack/GitHub/Linear/Jira clones to **teams testing agents**, mostly via API/MCP base-URL swap; webhook/event delivery into a deployed agent is claimed only by Arga (and emulate). All closed-source except emulate (and possibly Pome).
3. **RL-environment vendors** (Deeptune -> Mercor, Halluminate, Plato, Mechanize, Matrices, Collinear, Veris, Fleet, Chakra, Bespoke, Patronus, Scale/Surge/Turing/Mercor) sell realistic Slack/Jira/Salesforce clones to **frontier labs for training**, at $100k+ per environment (unverified). They are not testing an app's deployed channel path; low direct threat, possible data source / validation partner.
4. **Eval/simulation platforms** (LangSmith, LangWatch Scenario, Braintrust, Arize, Galileo, Maxim, Cekura, Coval, Bluejay, Okareo, Patronus, Promptfoo->OpenAI, Inspect) simulate the **user/LLM side** and call the agent in-process (`call()` adapter, HTTP endpoint, phone number). None drive Slack/GitHub/Linear webhook ingress. They are complementary: channelstack transcripts could be the input to their judges.

## 1. Agent simulation / eval platforms (simulate the user or LLM, not the provider)

| Company | What it simulates | Real webhooks/channels? | OSS? | Funding | Pricing / traction | Source |
|---|---|---|---|---|---|---|
| **LangWatch Scenario** | Simulated user agent + judge agent, multi-turn; red-team mode (Apr 2026) | No. Agent wrapped via a `call()` adapter in your test runner | SDK Apache-2.0, 1,031 stars, ~128k npm dl/mo (`@langwatch/scenario`); platform commercial | EUR 1M pre-seed, Feb 2025 (Passion Capital) | Platform has free tier + paid | https://github.com/langwatch/scenario , https://langwatch.ai/blog/langwatch-ai-announcing-1m-funding-round-to-bring-the-power-of-evaluations-to-ai-teams |
| **LangSmith** (LangChain) | Multi-turn simulation via OpenEvals `create_llm_simulated_user` / `run_multiturn_simulation`; threads for online multi-turn evals | No | OpenEvals OSS (MIT); LangSmith commercial | LangChain (parent) | Seat + trace pricing | https://docs.langchain.com/langsmith/multi-turn-simulation |
| **Braintrust** | Evals, scorers, observability; no provider env | No | No (some OSS SDKs/autoevals) | $80M Series B, Feb 17 2026, ICONIQ, $800M post (aggregators; total ~$121-124M unverified) | Free tier + Pro/Enterprise | https://siliconangle.com/2026/02/17/braintrust-breaks-80m-series-b-funding-round-become-observability-layer-ai/ |
| **Arize** (Phoenix) | Evals/observability | No | Phoenix OSS | $70M Series C, Feb 2025 (~$131M total, unverified) | | https://www.caplight.com/company/arize |
| **Galileo** | Evals, guardrails, agent reliability metrics | No | No | $45M Series B, Oct 2024 (~$68M total) | | aggregator, unverified |
| **Patronus AI** | Evals + now RL environments (coding, computer use, simulated apps, mock websites) for labs and enterprises | No for channels | Some OSS models (Lynx/Glider) | $50M Series B, Jun 25 2026; $17M A May 2024 (per own page) | | https://www.patronus.ai/resources/rl-environment-startups |
| **Maxim AI** | Simulation (simulated users/personas) + evals + observability | No | No | $3M, Jun 2024 (Elevation) | | https://www.kmworld.com/Articles/News/News/Maxim-AI-raises-%243M-to-help-enterprises-test-and-rapidly-ship-AI-products-164822.aspx |
| **Cekura** (YC F24, ex-Vocera) | Simulated personas for voice + chat agents; replays prod failures | Phone/voice/chat endpoints, not Slack/GitHub/Linear | No | ~$2.4M seed (unverified date) | | https://www.cekura.ai/ |
| **Coval** (YC) | "Self-driving sim" for voice/chat agents; synthetic scenarios + prod monitoring | Voice calls / chat endpoints | No | $28M Series A, Jun 24 2026, Norwest ($31M total); customers Zoom, Deepgram | | https://thenextweb.com/news/coval-28m-series-a-voice-ai-testing |
| **Bluejay** (YC) | Simulated callers (accents, noise) for voice agents | Voice only | No | $4M seed, Aug 2025 (lead reported inconsistently) | | https://www.newsbytesapp.com/news/business/bluejay-raises-4-million-to-test-ai-voice-agents/tldr |
| **Okareo** | Scenario generation, multi-turn sim, evals | No | No | ~$4.4M total, seed May 2024 (unverified) | | https://www.vcbacked.co/company/okareo |
| **Haize Labs** | Red-teaming / "haizing", judges | No | Some OSS | Conflicting: $12.5M seed / $25.5M total; reported acquired by Beacon Software Sep 2026 (single aggregator, unverified) | | https://www.cbinsights.com/company/haize-labs |
| **Promptfoo** | Prompt/agent evals + red-teaming, CLI | No (can hit HTTP endpoints) | MIT, 27.5k stars | $23.6M raised; **acquiring company: OpenAI, announced Mar 9 2026** (price undisclosed; "$86M" headline unverified); stays OSS; folded into OpenAI Frontier | Used by >25% of F500 (OpenAI claim) | https://promptfoo.dev/blog/promptfoo-joining-openai , https://techcrunch.com/2026/03/09/openai-acquires-promptfoo-to-secure-its-ai-agents/ |
| **Inspect AI** (UK AISI) | Eval framework; sandboxes (Docker), tools, agent scaffolds | No | MIT, 3.3k stars | Government | Free | https://github.com/UKGovernmentBEIS/inspect_ai |
| **Botium / Cyara** | Classic chatbot testing, 45-55 connectors (Genesys, Dialogflow, MS CLU...); generic HTTP connector | No confirmed Slack/Teams connector found | Botium core was OSS (legacy); Cyara commercial | Cyara acquired Botium 2022 | Enterprise CX | https://www.cxtoday.com/data-analytics/cyara-acquires-botium/ |
| Others with user simulators | Strands Evals (AWS), Opik `run_simulation`, DeepEval conversation simulator, Google Gemini Enterprise "simulate agent behavior" | No | mostly OSS | | | https://strandsagents.com/blog/simulate-realistic-users-multi-turn-agents-strands-evals/ |

Takeaway: this whole category treats the agent as a function (`call(messages) -> reply`) or a phone number. None exercise "event in -> platform routing -> agent run -> replies" through Slack/GitHub/Linear. They are complements: channelstack's scripted actors could optionally be LLM-driven, and its rendered transcripts could feed LangSmith/Braintrust/Scenario judges.

## 2. SaaS twins for app/agent developers (closest commercial overlap)

| Company | Twins | Webhooks into deployed agent? | Connection | OSS? | Funding / traction | Source |
|---|---|---|---|---|---|---|
| **vercel-labs/emulate** | Slack, GitHub, **Linear**, Google (Gmail/Cal/Drive), Stripe, Twilio, AWS, Okta, Clerk, Vercel, Resend, MongoDB Atlas, Microsoft, Apple, "AI" | **Yes, signed**: Slack Events API + interactivity + retries; GitHub App webhooks (HMAC); Linear webhooks incl. AgentSessionEvent | Base URL per service / reverse proxy / Next adapter; not MITM | **Apache-2.0**, 1,997 stars, 147 forks, ~2.54M npm dl/mo; main author `ctate` (166 commits) | Vercel Labs experiment | https://github.com/vercel-labs/emulate |
| **Hue** (YC F26, launched Oct 29 2026) | 25+ apps: Gmail, Slack, Salesforce, Jira, Notion, Linear, GitHub, QuickBooks... "Worlds", worlds-from-traces | Not stated | "Point app clients at Hue"; API, MCP, Composio, Pipedream | No | Funding undisclosed; demo-only pricing; fidelity unproven per press | https://byteiota.com/hue-ai-agent-testing-with-simulated-slack-gmail-and-jira/ , https://docs.hue.run |
| **Arga Labs** (YC P26) | 17-30+ twins: Stripe, Slack, GitHub, Gmail/GSuite, HubSpot, Salesforce... plus per-PR ephemeral staging that routes untouched services to prod | **Yes** ("twins support webhook events" per YC page) | Same endpoints/SDKs/MCP; seeded by natural language | No | $10M seed, Aug 26 2026, General Catalyst (+BoxGroup, Emergence, SV Angel); ~$40k MRR in 7 weeks and 100k twin instances in 16 weeks (unverified) | https://www.ycombinator.com/companies/arga-labs , https://techcrunch.com/2026/08/26/arga-is-building-a-better-way-to-train-enterprise-ai-agents |
| **Drizz** (twins) | 10 twins incl. Slack, GitHub, Jira, Linear; "simulated companies" with graded run reports | Not stated (API + MCP calls) | API/MCP | No | Book-a-demo | https://www.drizz.dev/labs/twins/slack-2026 |
| **StateWeave** | Slack, Gmail, Salesforce, Shopify, Zendesk, Google Cal/Sheets/Drive, WhatsApp, Teams | Not stated | Hosted; SDK for coding agents | No | Product Hunt launch; contact pricing | https://www.producthunt.com/products/stateweave |
| **Pome** | GitHub, Slack, Stripe, Gmail, Linear via MCP; "tape" of calls + state changes | Not stated | MCP server, local | Repo `pome-sh/digital-twins` 404 at time of check; license unknown | | https://mcpmarket.com/server/pome |
| **Archal** | Stateful API sandboxes for agent testing | Unknown (page 403) | | | | https://app.dealroom.co/news/note/archal-stateful-api-sandboxes-for-ai-agent-testing |
| **WonderTwin AI -> LocalStack** | 24+ apps incl. GitHub, HubSpot, PostHog, Stripe; local behavioral binaries | Unclear | Redirect non-prod traffic | Partly (unclear) | Acquired by LocalStack, announced Sep 14 2026, terms undisclosed | https://www.remio.ai/post/localstack-acquires-wondertwin-ai-expanding-the-local-test-boundary |
| **Veris AI** | Simulated copies of a team's systems, data, APIs and users (fintech, manufacturing, SaaS) for training + testing | Not stated | | No | $8.5M seed, Jun 3 2025 (Decibel, Acrew) | https://www.businesswire.com/news/home/20250603868539/en |

Takeaway: "realistic Slack/GitHub/Linear for app developers" is now an actively funded category (2026), but sold as hosted twins for **tool-call** testing (agent calls Slack). The inbound side channelstack cares about (signed events triggering a deployed agent, multi-actor threads, assertions on what users would see) is only covered explicitly by emulate (OSS) and claimed by Arga. Nobody I found does transparent HTTPS interception of unmodified deployed code, nor publishes spec-conformance evidence; press repeatedly flags fidelity as unproven (Hue).

## 3. RL environment vendors (sell to frontier labs)

| Company | What | Customers | Funding | Source |
|---|---|---|---|---|
| **Deeptune** | Hundreds of envs modelled on Slack, Salesforce, Excel, DevOps tools | Frontier labs | $43M Series A, Mar 2026 (a16z); **acquired by Mercor, Jul 9 2026** | https://fortune.com/2026/03/19/andreessen-horowitz-ai-startups-deeptune-series-a/ |
| **Halluminate** (YC S25) | Finance desktops (IB/PE/consulting), Westworld benchmark | Claims 4 of 5 top US closed labs | $30M Series A, Oct 1 2026, Oak HC/FT ($38.5M total) | https://fortune.com/2026/10/01/halluminate-raises-30-million-series-a-oakhc-ft/ |
| **Plato** | Resettable simulated workplaces (support, HR, finance, healthcare admin); scores constraint-following | AI developers (RL); enterprises as prospective | $16M Series A, ~Oct 28/Nov 4 2026, Nava Ventures ($19M total) | https://www.eweek.com/news/plato-16-million-ai-agent-training-simulations/ |
| **Mechanize** | SWE RL environments | Reportedly Anthropic | $9.1M at $500M post, Apr 2026 (per Patronus list, unverified) | https://www.mechanize.work/ |
| **Matrices** | Computer-use environments | Labs | ~$5M (unverified), YC | https://www.rl-list.com/rl-environments-for-computer-use |
| **Collinear** | SimLab: stateful RL envs mimicking Jira, ServiceNow | 3 of top 4 labs, Amazon, ServiceNow, IBM (AWS case study) | Undisclosed | https://www.rl-list.com/vendors/collinear |
| **Chakra Labs** | Deterministic pixel-perfect clones (GUI + MCP) incl. Slack, GitHub; 1,000-task benchmark over 8 apps | Labs | Undisclosed | https://www.rl-list.com/vendors/chakra-labs |
| **Fleet**, **Bespoke Labs** ($40M Jul 2026), **Idler** ($9M), **Prime Intellect** Env Hub ($130M Jul 2026, 2,500+ community envs), **HUD** SDK | Mixed | Labs/enterprises | as listed | https://www.patronus.ai/resources/rl-environment-startups |
| **Scale, Surge, Turing, Mercor, Snorkel** | Expert data + environment building as a service | Labs | Large/private | https://techcrunch.com/2025/09/16/silicon-valley-bets-big-on-environments-to-train-ai-agents/ |

Market colour: labs reportedly pay ~$20k for a basic website clone and ~$300k for a Slack-grade clone (Epoch AI investigation via secondary article, unverified): https://aiforautomation.io/news/2026-03-21-ai-companies-spend-1b-building-fake-websites-training-environments . Chakra's own essay "RL environments are worthless" argues commoditisation: https://www.chakra.dev/publications/rl-environments-are-worthless

## 4. Academic benchmarks with simulated apps

| Benchmark | Simulates | Channel realism | Repo |
|---|---|---|---|
| tau-bench / **tau2-bench** (Sierra) | LLM user simulator + domain DB/tools (airline, retail, telecom); dual-control | Tool-level, no real APIs | sierra-research/tau2-bench, MIT, 2.5k stars |
| **AppWorld** | 9 day-to-day apps (Venmo-like, Spotify-like, Gmail-like...) with 457 APIs, stateful | API-level, Python | StonyBrookNLP/appworld, Apache-2.0, 557 stars |
| **WebArena** | Self-hosted web apps (GitLab, Reddit clone, shopping, CMS, maps) | Browser | web-arena-x/webarena, 1.6k stars |
| **TheAgentCompany** (CMU) | Simulated company: **RocketChat**, GitLab, Plane, ownCloud, with LLM-simulated colleagues | Real OSS apps self-hosted; agent drives browser/API; simulated coworkers chat | TheAgentCompany/TheAgentCompany, MIT, 822 stars (last push Nov 2025) |
| **AgentDojo** (ETH) | Workspace/Slack/banking/travel tool suites for prompt-injection security | Python function tools (has a "slack" suite) | ethz-spylab/agentdojo, MIT, 1.1k stars |
| **OSWorld** | Full desktop VMs | GUI | xlang-ai/OSWorld, 3.3k stars |

Takeaway: TheAgentCompany is the conceptual cousin (simulated coworkers in a chat app), but it uses RocketChat instead of Slack and evaluates the model, not a deployed app's ingress. AgentDojo's Slack suite is a useful source of adversarial scenarios (prompt injection via channel messages) channelstack could port.

## 5. MCP / tool mocking

- Generic patterns: mock MCP transports, mock MCP servers returning canned responses, JSON-RPC interception (https://truto.one/blog/how-to-test-and-mock-mcp-servers-in-cicd-without-hitting-live-apis/ , https://www.fast.io/resources/mocking-mcp-servers-testing/). Vendors: Microsoft Agent 365 mock tooling server (https://learn.microsoft.com/microsoft-agent-365/developer/mock-tooling-server), MockServer MCP tools, mockd, WireMock AI/MCP docs (https://docs.wiremock.io/ai-mcp/ai-101.md).
- Arcade / Composio: I found no documented "test mode" or sandbox fakes for Slack/GitHub/Linear. Hue explicitly connects *through* Composio and Pipedream, i.e. those tool platforms are distribution channels for twin vendors rather than competitors. (Not verified in their own docs.)
- These operate at the tool-call layer only; none cover inbound events.

## 6. Answer: is anyone selling realistic Slack/GitHub/Linear environments, and to whom?

Yes, two distinct markets:

1. **RL labs (training)**: Deeptune (now Mercor), Halluminate, Plato, Collinear, Chakra, Mechanize, Scale/Surge/Turing. High-priced bespoke clones, evaluated on task reward, aimed at model behaviour. Do not care about an app's webhook ingress, signature checks, thread routing, or rendered Block Kit. **Low threat.** Possible **data source** (task/scenario corpora) and a validation story ("our fakes are good enough for labs").
2. **App/agent developers (testing)**, which became a funded category in 2026: Hue, Arga ($10M), Drizz, StateWeave, Pome, LocalStack+WonderTwin, Veris; and in OSS, **vercel-labs/emulate**. These are the real competition for the "provider fake" layer. Commercial ones are closed, hosted, demo-gated and mostly outbound tool-call focused.

What it means for an OSS channelstack:
- **Threat**: emulate already ships signed inbound events for exactly Slack + GitHub + Linear, including Linear Agent Sessions and Slack interactivity, with huge npm reach (likely transitively via Vercel templates). A channelstack that re-implements fakes will look redundant. Commercial twin vendors (Arga, Hue) could add conversation assertions quickly.
- **Partner**: build channelstack's provider layer on emulate (or contribute upstream: Socket Mode, slash commands, streaming, rate limits, spec-conformance tests), and put the value in what nobody has: transparent HTTPS interception so deployed code runs unmodified, scripted multi-human actors, assertions on the rendered conversation (threads, edits, reactions, Block Kit), and published fidelity evidence against provider OpenAPI specs / recorded traffic. Eval platforms (LangSmith, Scenario, Braintrust) are natural integrations: channelstack produces the transcript, they judge quality.
- **Data source**: AgentDojo Slack suite and TheAgentCompany coworker scripts for scenarios; RL vendors' public benchmarks for realistic workflows; emulate's seed format for fixtures.
- **Positioning gap still open**: "Playwright for agents that live in chat/issue trackers" (end-to-end through the platform's routing, deterministic, OSS, spec-verified) is not claimed by anyone found here. The fidelity question ("how do you know the fake matches Slack?") is the recurring critique of every twin vendor and is channelstack's best wedge.
