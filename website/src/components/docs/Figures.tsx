/**
 * The docs' animated figures. Each one is CSS animation on fixed classes (the site's
 * Content-Security-Policy allows no inline styles), carries its meaning in a visible caption,
 * and shows its finished state to people who ask for reduced motion (styles/figures.css).
 */
import { Fragment, useState } from "react";

import { FIGURE_CAPTIONS, type FigureCaption, type FigureName } from "./figure-captions";

/** `dev` in backticks, set as code. */
const inline = (text: string) =>
  text
    .split("`")
    .map((part, index) => (index % 2 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>));

/**
 * A figure's caption (figure-captions.ts). Numbered steps light up in turn with the figure:
 * `step-1` with `pkt-1`, and so on.
 */
function Caption({ figure }: { figure: FigureName }) {
  const caption: FigureCaption = FIGURE_CAPTIONS[figure];
  return (
    <figcaption>
      {"steps" in caption ? (
        <ol className="fig-steps">
          {caption.steps.map((text, index) => (
            <li key={text} className={`step-${index + 1}`}>
              {inline(text)}
            </li>
          ))}
        </ol>
      ) : (
        inline(caption.text)
      )}
    </figcaption>
  );
}

/** A test's message reaching the app, and the app's reply coming back to the test. */
export function RequestFlow() {
  return (
    <figure className="fig fig-flow">
      <div className="flow-stage" aria-hidden="true">
        <div className="fig-node">
          <b>Your test</b>
          <code>ana.say</code>
          <code>expect</code>
        </div>
        <div className="fig-lane">
          <span className="pkt pkt-1">ana.say</span>
          <span className="pkt pkt-4 back">reply ✓</span>
        </div>
        <div className="fig-node accent">
          <b>channelstack</b>
          <span>fake Slack</span>
        </div>
        <div className="fig-lane">
          <span className="pkt pkt-2">app_mention</span>
          <span className="pkt pkt-3 back">chat.postMessage</span>
        </div>
        <div className="fig-node">
          <b>Your app</b>
          <span>unchanged</span>
          <span>real SDK</span>
        </div>
      </div>
      <Caption figure="RequestFlow" />
    </figure>
  );
}

export interface TerminalLine {
  /** A command, typed after a prompt. */
  cmd?: string;
  /** Output, shown when the command finishes. */
  out?: string;
  /** Output in the success color. */
  ok?: boolean;
}

/** Commands typed out, each followed by its output. Up to 14 lines. */
export function TerminalSession({ title = "Terminal", lines }: { title?: string; lines: TerminalLine[] }) {
  const [run, setRun] = useState(0);
  return (
    <figure className="fig fig-term">
      <div className="term-bar">
        <span className="term-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="term-title">{title}</span>
        <button type="button" className="term-replay" onClick={() => setRun((count) => count + 1)}>
          Replay
        </button>
      </div>
      <pre className="term-body" key={run}>
        {lines.map((line, index) => (
          <span key={index} className={`term-line${line.cmd ? " cmd" : ""}${line.ok ? " ok" : ""}`}>
            {line.cmd ? (
              <>
                <span className="term-prompt" aria-hidden="true">
                  ${" "}
                </span>
                <span className="term-typed">{line.cmd}</span>
              </>
            ) : (
              line.out
            )}
            {"\n"}
          </span>
        ))}
      </pre>
    </figure>
  );
}

/** Parallel tests, each in its own session of the one shared workspace, cleaned up when it ends. */
export function SessionScopes() {
  const tests = [
    { name: "test A", items: ["Ana", "#c-1", "@my-agent deploy", "reply"] },
    { name: "test B", items: ["Ben", "#c-2", "@my-agent hi", "reply"] },
    { name: "test C", items: ["Cara", "DM", "status?", "reply"] },
  ];
  return (
    <figure className="fig fig-scopes">
      <div className="scopes-world" aria-hidden="true">
        <p className="scopes-label">One fake Slack workspace · Acme · app my-agent</p>
        <div className="scopes-grid">
          {tests.map((test, column) => (
            <div key={test.name} className={`scope scope-${column + 1}`}>
              <p className="scope-name">
                {test.name}
                <span>session</span>
              </p>
              <ul>
                {test.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className="scope-closed">closed · cleaned up</p>
            </div>
          ))}
        </div>
        <p className="scope-dev">
          <b>dev</b> session · the CLI, the UI and MCP · lives until the server stops
        </p>
      </div>
      <Caption figure="SessionScopes" />
    </figure>
  );
}

/** A negative check watches until the app has been quiet for the whole window, then checks once. */
export function QuietWindow() {
  return (
    <figure className="fig fig-quiet">
      <div className="quiet-stage" aria-hidden="true">
        <code className="quiet-call">await expect(thread).not.toHaveReplyFrom("my-agent")</code>
        <div className="quiet-track">
          <span className="quiet-busy">app busy</span>
          <span className="quiet-event e1">delivery</span>
          <span className="quiet-event e2">API call</span>
          <span className="quiet-event e3">stream end</span>
          <span className="quiet-window">
            <i />
            <em>quiet for 750 ms</em>
          </span>
          <span className="quiet-check">check ✓</span>
          <span className="quiet-head" />
        </div>
        <div className="quiet-axis">
          <span>check starts watching</span>
          <span>time →</span>
        </div>
      </div>
      <Caption figure="QuietWindow" />
    </figure>
  );
}

/** Slack retrying a delivery the app acknowledged too late, and an app that answers once anyway. */
export function RetryTimeline() {
  return (
    <figure className="fig fig-retry">
      <div className="retry-stage" aria-hidden="true">
        <div className="retry-row">
          <span className="retry-who">Slack</span>
          <div className="retry-track">
            <span className="retry-mark r1">attempt 1</span>
            <span className="retry-mark r2">attempt 2 · X-Slack-Retry-Num: 1</span>
          </div>
        </div>
        <div className="retry-row">
          <span className="retry-who">Your app</span>
          <div className="retry-track">
            <span className="retry-work">working on it…</span>
            <span className="retry-mark r3">seen Ev0MPS… → ack, skip</span>
          </div>
        </div>
        <div className="retry-row">
          <span className="retry-who">Thread</span>
          <div className="retry-track">
            <span className="retry-mark r4">one reply ✓</span>
          </div>
        </div>
        <div className="retry-axis">
          <span>0 s</span>
          <span>3 s</span>
          <span>6 s</span>
        </div>
        <span className="retry-head" />
      </div>
      <Caption figure="RetryTimeline" />
    </figure>
  );
}

/** Proxy mode: requests to the platforms' own hosts go to the fakes; every other host passes through. */
export function ProxyRouting() {
  const routes = [
    { host: "slack.com", to: "fake Slack" },
    { host: "api.github.com", to: "fake GitHub" },
    { host: "api.openai.com", to: "the internet, untouched" },
  ];
  return (
    <figure className="fig fig-proxy">
      <div className="proxy-stage" aria-hidden="true">
        <div className="fig-node">
          <b>Your app</b>
          <span>calls slack.com</span>
          <span>HTTPS_PROXY set</span>
        </div>
        <div className="fig-lane">
          <span className="pkt pkt-1">CONNECT</span>
        </div>
        <div className="fig-node accent">
          <b>proxy</b>
          <span>127.0.0.1:7464</span>
        </div>
        <div className="proxy-routes">
          {routes.map((route, index) => (
            <div key={route.host} className={`proxy-route route-${index + 1}`}>
              <div className="fig-lane">
                <span className={`pkt pkt-${index + 2}`}>{route.host}</span>
              </div>
              <span className={`proxy-dest${index === 2 ? " pass" : ""}`}>{route.to}</span>
            </div>
          ))}
        </div>
      </div>
      <Caption figure="ProxyRouting" />
    </figure>
  );
}

/** The same test against the fake and against a real sandbox workspace. */
export function FakeOrLive() {
  const [mode, setMode] = useState<"fake" | "live">("fake");
  const rows =
    mode === "fake"
      ? [
          ["Slack is", "channelstack's fake, in memory"],
          ["Ana is", "a fake person the test created"],
          ["The event reaches the app", "from channelstack, signed like Slack's"],
          ["Retries, bad signatures, faults", "yes"],
          ["Runs", "on every pull request, in seconds"],
        ]
      : [
          ["Slack is", "a real sandbox workspace"],
          ["Ana is", "a real sandbox account, with her own token"],
          ["The event reaches the app", "from Slack itself, as in production"],
          ["Retries, bad signatures, faults", "not live: no delivery to test, and faults skip"],
          ["Runs", "nightly, against the allowlisted workspace"],
        ];
  return (
    <figure className={`fig fig-reality is-${mode}`}>
      <div className="reality-switch" role="group" aria-label="Run the test against">
        <button type="button" aria-pressed={mode === "fake"} onClick={() => setMode("fake")}>
          Fake
        </button>
        <button type="button" aria-pressed={mode === "live"} onClick={() => setMode("live")}>
          Live
        </button>
      </div>
      <pre className="reality-code">
        <code>
          {`const ana = await slack.createUser({ name: "Ana" });
const msg = await ana.say("@my-agent hi", { channel });
await expect(msg.thread).toHaveReplyFrom("my-agent");`}
        </code>
      </pre>
      <dl className="reality-rows" key={mode}>
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Caption figure="FakeOrLive" />
    </figure>
  );
}
