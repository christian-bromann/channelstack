/**
 * The docs' animated figures. Each one is CSS animation on fixed classes (the site's
 * Content-Security-Policy allows no inline styles), carries its meaning in a visible caption,
 * and shows its finished state to people who ask for reduced motion (styles/figures.css).
 */
import { useState } from "react";

/** The packets and steps of a figure light up in turn: `step-1` with `pkt-1`, and so on. */
const steps = (texts: readonly string[]) => (
  <ol className="fig-steps">
    {texts.map((text, index) => (
      <li key={text} className={`step-${index + 1}`}>
        {text}
      </li>
    ))}
  </ol>
);

/** A test's message reaching the agent, and the agent's reply coming back to the test. */
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
          <b>Your agent</b>
          <span>unchanged</span>
          <span>real SDK</span>
        </div>
      </div>
      <figcaption>
        {steps([
          "The test acts as Ana: she mentions the agent in a channel.",
          "The fake Slack delivers the event to your agent, signed, the way Slack does.",
          "Your agent answers through the Slack API it already uses, which now points at the fake.",
          "The matcher reads the thread as Ana would see it, and passes.",
        ])}
      </figcaption>
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
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed for the page
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
      <figcaption>
        Tests run in parallel against one server. Each test gets its own session: it sees only the people, channels and
        deliveries it created, and everything goes away when it ends. The CLI, the UI and MCP share one long-lived
        session called <code>dev</code>.
      </figcaption>
    </figure>
  );
}

/** A negative check watches until the agent has been quiet for the whole window, then checks once. */
export function QuietWindow() {
  return (
    <figure className="fig fig-quiet">
      <div className="quiet-stage" aria-hidden="true">
        <code className="quiet-call">await expect(thread).not.toHaveReplyFrom("my-agent")</code>
        <div className="quiet-track">
          <span className="quiet-busy">agent busy</span>
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
      <figcaption>
        {steps([
          "The check starts watching. The agent is still busy: a delivery is in flight, then its API calls, then a stream.",
          "Once nothing is open, the quiet window starts. Anything the agent does now restarts it.",
          "After 750 ms of quiet, watched from start to end, the check reads the thread once.",
        ])}
      </figcaption>
    </figure>
  );
}

/** Slack retrying a delivery the agent acknowledged too late, and an agent that answers once anyway. */
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
          <span className="retry-who">Your agent</span>
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
      <figcaption>
        {steps([
          "Slack delivers the event. Without an answer within 3 seconds it counts the delivery as failed.",
          "It sends the same event again, with the attempt number and the reason in its retry headers.",
          "An agent that remembers the event id acknowledges the retry and does nothing else.",
          "The thread gets one reply. An agent that doesn't check answers twice.",
        ])}
      </figcaption>
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
          <b>Your agent</b>
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
      <figcaption>
        {steps([
          "The agent calls the platform's real host. The proxy in its environment takes the connection.",
          "slack.com, api.github.com, api.linear.app and api.notion.com go to the fakes, under a certificate only the agent trusts.",
          "The fakes answer exactly as they do on *.localhost.",
          "Every other host, such as the model's API, passes through untouched.",
        ])}
      </figcaption>
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
          ["The event reaches the agent", "from channelstack, signed like Slack's"],
          ["Retries, bad signatures, faults", "yes"],
          ["Runs", "on every pull request, in seconds"],
        ]
      : [
          ["Slack is", "a real sandbox workspace"],
          ["Ana is", "a real sandbox account, with her own token"],
          ["The event reaches the agent", "from Slack itself, as in production"],
          ["Retries, bad signatures, faults", "skipped, with the reason"],
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
      <figcaption>
        The test doesn't change. Credentials in the environment decide whether it runs against the fake or the real
        platform.
      </figcaption>
    </figure>
  );
}
