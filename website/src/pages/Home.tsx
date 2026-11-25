import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import vitestConfig from "../../samples/quickstart/vitest.config.ts?sample";
import { Code, CopyButton, Terminal } from "../components/Code";
import { Flow } from "../components/Flow";
import { Footer } from "../components/Footer";
import { HeroWaves } from "../components/HeroWaves";
import { ArrowRight, Person, Route, Shield, Transcript } from "../components/Icons";
import { Nav } from "../components/Nav";
import { Player } from "../components/Player";
import { Seo } from "../components/Seo";
import { Voice } from "../components/Voice";
import { useReveal } from "../lib/hooks";
import { SITE } from "../lib/site";

/**
 * Official logo files per channel, by theme, shown unmodified. Sources, guidelines and the
 * decision to show them are recorded in public/logos/SOURCES.md.
 */
const LOGOS: Partial<Record<string, { onLight: string; onDark: string }>> = {
  slack: { onLight: "/logos/slack.svg", onDark: "/logos/slack.svg" },
  github: { onLight: "/logos/github.svg", onDark: "/logos/github-white.svg" },
  linear: { onLight: "/logos/linear.svg", onDark: "/logos/linear-light.svg" },
  notion: { onLight: "/logos/notion.svg", onDark: "/logos/notion.svg" },
};

const CHANNELS = [
  {
    id: "slack",
    name: "Slack",
    text: "DMs, mentions, threads and the agent view, with progress streams rendered the way people see them.",
    chips: ["Events API", "block_actions", "chat.startStream", "assistant.threads", "agent_session_stopped"],
  },
  {
    id: "github",
    name: "GitHub",
    text: "Apps with installations, signed deliveries with real GUIDs, and redelivery for dedupe tests.",
    chips: ["App manifests", "issue_comment", "pull_request", "check_run", "redeliver"],
  },
  {
    id: "linear",
    name: "Linear",
    text: "Agent sessions end to end: delegation, prompts, questions, activities and the Stop signal.",
    chips: ["delegation", "AgentSessionEvent", "agentActivityCreate", "stop signal"],
  },
  {
    id: "notion",
    name: "Notion",
    text: "Pages, databases and comments, with webhooks when someone mentions your integration.",
    chips: ["page webhooks", "comments", "database queries", "blocks"],
  },
];

const PRINCIPLES: Array<{ icon: ReactNode; title: string; body: ReactNode }> = [
  {
    icon: <Route size={22} />,
    title: "Your agent’s real code path",
    body: (
      <>
        <code>channelstack env</code> points your agent’s own SDKs at <code>slack.localhost</code>,{" "}
        <code>github.localhost</code> and friends. Agents with hard-coded hosts use proxy mode instead: set{" "}
        <code>HTTPS_PROXY</code> and trust a CA that only that agent sees.
      </>
    ),
  },
  {
    icon: <Shield size={22} />,
    title: "Shapes that can’t drift",
    body: (
      <>
        Every response and webhook is checked against the providers’ own schemas: OpenAPI descriptions, GraphQL
        introspection and recorded traffic. When a platform changes, your build goes red instead of quietly wrong.
      </>
    ),
  },
  {
    icon: <Person size={22} />,
    title: "People, not payloads",
    body: (
      <>
        Write <code>ana.click("Approve", {"{ message }"})</code> instead of hand-building a <code>block_actions</code>{" "}
        body. People post, reply, review, delegate and press Stop, with correct signatures, retries and delivery IDs.
      </>
    ),
  },
  {
    icon: <Transcript size={22} />,
    title: "Assert what people see",
    body: (
      <>
        Streams, status lines, edits and ephemeral messages render into one transcript.{" "}
        <code>toHaveRepliesFrom(…, {"{ count: 1 }"})</code> catches the double post. <code>not.toContainText</code>{" "}
        catches the leftover “Thinking…” reply.
      </>
    ),
  },
];

type Cell = [tone: "y" | "n" | "p", text: string];
const COMPARE: Array<[string, Cell, Cell, Cell, Cell]> = [
  [
    "Agent code unchanged",
    ["n", "No"],
    ["p", "Base URL overrides"],
    ["y", "Yes"],
    ["y", "Yes: a base URL, or a proxy"],
  ],
  [
    "Platform calls your agent",
    ["n", "No"],
    ["p", "Some webhooks"],
    ["y", "Yes"],
    ["y", "Signed, retried, replayable"],
  ],
  ["Scripted people", ["n", "No"], ["n", "No"], ["p", "Manual or second bot"], ["y", "Built in"]],
  ["Payload shapes checked", ["n", "No"], ["n", "No"], ["y", "They’re real"], ["y", "Against provider schemas"]],
  ["Assert on what people see", ["n", "No"], ["n", "Raw state"], ["p", "Screenshots"], ["y", "Rendered transcript"]],
  ["Offline, parallel CI", ["y", "Yes"], ["y", "Yes"], ["n", "No"], ["y", "Yes"]],
  ["Same test against the real platform", ["n", "No"], ["n", "No"], ["y", "Yes"], ["y", "Live mode"]],
];

export default function Home() {
  const channels = useReveal<HTMLDivElement>();
  const principles = useReveal<HTMLDivElement>();
  const flow = useReveal<HTMLDivElement>();
  const steps = useReveal<HTMLOListElement>();

  return (
    <>
      <Seo title={SITE.title} path="/" structured />
      <Nav />
      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-bg" aria-hidden="true" />
          <div className="wrap">
            <HeroWaves />
            <p className="eyebrow">
              <span className="rec" aria-hidden="true" />
              Test harness for agents that live in chat
            </p>
            <h1 id="hero-title">
              Your agent’s whole world, <em>on localhost.</em>
            </h1>
            <p className="lede">
              channelstack recreates <strong>Slack, GitHub, Linear and Notion</strong> on your machine. Script the
              people, let your agent answer through its real code path, and assert on the conversation a person would
              see. Signed webhooks, real payload shapes and real ids, with no changes to how your agent works.
            </p>
            <div className="cta">
              <a className="btn primary" href="#quick-start">
                Get started
                <ArrowRight size={16} className="arrow" />
              </a>
              <a className="btn" href="#why">
                Why channelstack?
              </a>
              <div className="install">
                <code>
                  <span className="prompt">$ </span>
                  {SITE.install}
                </code>
                <CopyButton text={SITE.install} label="Copy the install command" />
              </div>
            </div>
            <p className="soon">Not on npm yet. The first release is on its way.</p>
            <Player />
          </div>
        </section>

        <section id="channels" aria-labelledby="channels-title">
          <div className="wrap">
            <div className="sec-head">
              <p className="kicker">Four platforms, one API</p>
              <h2 id="channels-title">Everywhere your agent gets a message.</h2>
              <p className="sec-lede">
                One package fakes all four, with the people, events and API calls agents actually use. Use one in a
                test, or several when your agent spans them. Discord, Stripe and email come next.
              </p>
            </div>
            <div className="channels" ref={channels}>
              {CHANNELS.map((channel) => {
                const logo = LOGOS[channel.id];
                return (
                  <article key={channel.id} className="channel reveal">
                    <header>
                      {logo ? (
                        <span className={logo.onDark === logo.onLight ? "logo same" : "logo"}>
                          <img
                            className="on-light"
                            src={logo.onLight}
                            alt=""
                            width="32"
                            height="32"
                            loading="lazy"
                            decoding="async"
                          />
                          {logo.onDark === logo.onLight ? null : (
                            <img
                              className="on-dark"
                              src={logo.onDark}
                              alt=""
                              width="32"
                              height="32"
                              loading="lazy"
                              decoding="async"
                            />
                          )}
                        </span>
                      ) : null}
                      <h3>{channel.name}</h3>
                    </header>
                    <p>{channel.text}</p>
                    <ul>
                      {channel.chips.map((chip) => (
                        <li key={chip}>{chip}</li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section id="why" aria-labelledby="why-title">
          <div className="wrap">
            <div className="sec-head">
              <p className="kicker">Why channelstack</p>
              <h2 id="why-title">Mocks test your mock. channelstack tests your agent.</h2>
              <p className="sec-lede">
                Chat agents break in the gaps between systems: a webhook signed the wrong way, a payload shape that
                changed last month, a stray progress message nobody asserted on. channelstack closes those gaps.
              </p>
            </div>
            <div className="principles" ref={principles}>
              {PRINCIPLES.map((p) => (
                <div key={p.title} className="principle reveal">
                  <span className="principle-icon" aria-hidden="true">
                    {p.icon}
                  </span>
                  <div>
                    <h3>{p.title}</h3>
                    <p>{p.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how" aria-labelledby="how-title">
          <div className="wrap">
            <div className="sec-head">
              <p className="kicker">How it works</p>
              <h2 id="how-title">One server between your test and your agent.</h2>
              <p className="sec-lede">
                Your test scripts the people. channelstack delivers what the platform would deliver, and your agent
                answers with its real SDKs, into the same fake workspace your test reads back.
              </p>
            </div>
            <div ref={flow}>
              <Flow />
            </div>
          </div>
        </section>

        <section id="compare" aria-labelledby="compare-title">
          <div className="wrap">
            <div className="sec-head">
              <p className="kicker">Compared</p>
              <h2 id="compare-title">Between mocks and a real workspace.</h2>
              <p className="sec-lede">
                Real sandbox workspaces are slow, shared and flaky in CI. Mocks are fast but only prove your code
                matches your own guess. channelstack keeps the speed and drops the guessing.
              </p>
            </div>
            <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="compare-title">
              <table>
                <thead>
                  <tr>
                    <td />
                    <th scope="col">Hand-written mocks</th>
                    <th scope="col">API emulators</th>
                    <th scope="col">Real sandbox workspace</th>
                    <th scope="col" className="us">
                      channelstack
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARE.map(([row, ...cells]) => (
                    <tr key={row}>
                      <th scope="row">{row}</th>
                      {cells.map(([tone, text], i) => (
                        <td key={i} className={i === 3 ? `us ${tone}` : tone}>
                          {text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section id="quick-start" aria-labelledby="quick-start-title">
          <div className="wrap">
            <div className="sec-head">
              <p className="kicker">Quick start</p>
              <h2 id="quick-start-title">First passing test in three steps.</h2>
            </div>
            <ol className="steps" ref={steps}>
              <li className="step reveal">
                <p className="step-n">Step 1</p>
                <h3>Install</h3>
                <p>One package: the server, the CLI, the UI and the test integrations.</p>
                <div className="snippet">
                  <Terminal label="Install command" lines={[`$ ${SITE.install}`]} />
                </div>
              </li>
              <li className="step reveal">
                <p className="step-n">Step 2</p>
                <h3>Point your agent at it</h3>
                <p>
                  Each fake comes with an app named <code>my-agent</code>. Tell channelstack where your agent takes
                  events, then start the agent the way you always do, with channelstack’s environment.
                </p>
                <div className="snippet">
                  <Terminal
                    label="Commands to start your agent"
                    lines={[
                      "$ CHANNELSTACK_SLACK_WEBHOOK_URL=https://my-agent.localhost/slack/events npx channelstack &",
                      "$ npx channelstack env >> .env.local",
                      "$ portless run my-agent pnpm dev",
                    ]}
                  />
                </div>
              </li>
              <li className="step reveal">
                <p className="step-n">Step 3</p>
                <h3>Run</h3>
                <p>Add the plugin and run your tests as usual. A failure says what a person sees, and what the agent left open.</p>
                <div className="snippet">
                  <p className="snippet-file">vitest.config.ts</p>
                  <Code plain sample={vitestConfig} label="vitest.config.ts" />
                  <Terminal label="Test run" lines={["$ npx vitest", "✓ deploy.test.ts (1) 2.7s"]} />
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section className="closing" aria-labelledby="closing-title">
          <div className="wrap closing-grid">
            <div>
              <h2 id="closing-title">Test the conversation before your users have it.</h2>
              <div className="cta">
                <Link className="btn primary" to="/docs">
                  Read the docs
                  <ArrowRight size={16} className="arrow" />
                </Link>
                <a className="btn" href={SITE.repo}>
                  View on GitHub
                </a>
              </div>
            </div>
            <p className="why-name">
              <strong>Why “channelstack”?</strong> Your agent lives in a stack of channels: Slack, GitHub, Linear,
              Notion. channelstack runs that whole stack on localhost, with the people in it, so you can test the
              conversation end to end before your users have it.
            </p>
          </div>
          <div className="wrap">
            <Voice />
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
