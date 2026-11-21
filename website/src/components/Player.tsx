import { type ComponentType, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import github from "../../samples/github.test.ts?sample";
import slack from "../../samples/hero.test.ts?sample";
import linear from "../../samples/linear.test.ts?sample";
import live from "../../samples/live.test.ts?sample";
import notion from "../../samples/notion.test.ts?sample";
import pytest from "../../samples/test_keys.py?sample";
import type { Sample } from "../../plugins/samples-plugin";
import { prefersReducedMotion, useInView } from "../lib/hooks";
import { CopyButton } from "./Code";
import { Check, Pause, Play, Replay } from "./Icons";
import { GitHubMock, LinearMock, LiveMock, type MockProps, NotionMock, PytestMock, SlackMock } from "./Mocks";

interface Example {
  id: string;
  label: string;
  file: string;
  /** The address shown above the mock-up. */
  host: string;
  sample: Sample;
  Mock: ComponentType<MockProps>;
  /** What the test asserts, each shown once playback reaches its step. */
  checks: Array<{ step: number; text: string }>;
  notes: ReactNode[];
}

const EXAMPLES: Example[] = [
  {
    id: "slack",
    label: "Slack",
    file: "deploy.test.ts",
    host: "slack.localhost",
    sample: slack,
    Mock: SlackMock,
    checks: [
      { step: 2, text: "status reads “checking CI”" },
      { step: 3, text: "the reply has an Approve button" },
      { step: 5, text: "“Deployed” appears once, no leftover “Thinking…”" },
    ],
    notes: [
      <>Delivers a signed <code>message.im</code> event to your agent</>,
      <>Sends <code>block_actions</code> when Ana clicks Approve</>,
      <>Renders status lines and messages the way people see them</>,
    ],
  },
  {
    id: "github",
    label: "GitHub",
    file: "issues.test.ts",
    host: "github.localhost",
    sample: github,
    Mock: GitHubMock,
    checks: [
      { step: 3, text: "robin commented, mentioning Safari" },
      { step: 5, text: "one comment from robin after the redelivery" },
    ],
    notes: [
      <>Installs the App only on repos you list in <code>apps</code></>,
      <>Signs each delivery with <code>X-Hub-Signature-256</code></>,
      <>Redelivers with the same GUID, the way GitHub does</>,
    ],
  },
  {
    id: "linear",
    label: "Linear",
    file: "sessions.test.ts",
    host: "linear.localhost",
    sample: linear,
    Mock: LinearMock,
    checks: [
      { step: 3, text: "the session shows a thought" },
      { step: 5, text: "after Stop, the session is complete" },
    ],
    notes: [
      <><code>AgentSessionEvent</code> in Linear’s current shape</>,
      <>The <code>prompted</code> event carrying the stop signal</>,
      <>Every GraphQL response checked against Linear’s schema</>,
    ],
  },
  {
    id: "notion",
    label: "Notion",
    file: "comments.test.ts",
    host: "notion.localhost",
    sample: notion,
    Mock: NotionMock,
    checks: [
      { step: 3, text: "robin answered in the same discussion" },
      { step: 4, text: "exactly one comment from robin" },
    ],
    notes: [
      <>Connections and their inheritance, like Notion</>,
      <>Webhooks signed with <code>X-Notion-Signature</code></>,
      <><code>page.content_updated</code> batched the way Notion does</>,
    ],
  },
  {
    id: "live",
    label: "Live mode",
    file: "live.test.ts",
    host: "app.slack.com",
    sample: live,
    Mock: LiveMock,
    checks: [
      { step: 3, text: "reply from robin within 30s" },
      { step: 4, text: "cleaned up: 1 channel, 2 messages" },
    ],
    notes: [
      <>The same test runs against a real sandbox workspace</>,
      <>Acts as real people and reads the result back</>,
      <>Removes everything the test created</>,
    ],
  },
  {
    id: "pytest",
    label: "pytest",
    file: "test_keys.py",
    host: "slack.localhost",
    sample: pytest,
    Mock: PytestMock,
    checks: [{ step: 4, text: "“Okay, I left the keys alone.” appears once" }],
    notes: [
      <>The same fakes from Python through <code>pytest-channelstack</code></>,
      <>One channelstack server shared by JS and Python suites</>,
      <>Fixtures named after each platform</>,
    ],
  },
];

/** The step after the last tagged line or check: the finished run. */
const doneOf = (example: Example) => Math.max(...example.sample.steps, ...example.checks.map((c) => c.step)) + 1;

function Panel({ example, active, step, controls }: { example: Example; active: boolean; step: number; controls: ReactNode }) {
  const bar = useRef<HTMLSpanElement>(null);
  const { sample, Mock } = example;

  // The highlight bar moves with transform only. It is positioned here, not with a style
  // attribute, so the prerendered HTML carries no inline styles.
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const first = sample.steps.indexOf(step);
    if (!active || step < 1 || first === -1) {
      el.style.opacity = "0";
      return;
    }
    const rows = sample.steps.filter((s) => s === step).length;
    el.style.opacity = "1";
    el.style.transform = `translateY(calc(${first} * var(--code-lh))) scaleY(${rows})`;
  }, [active, step, sample]);

  return (
    <div className={active ? "panel is-active" : "panel"} role="tabpanel" id={`panel-${example.id}`} aria-labelledby={`tab-${example.id}`}>
      <div className="panel-code">
        <div className="pane-head">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>{example.file}</span>
          <span className="spacer" />
          <CopyButton text={sample.code} label={`Copy the ${example.label} example`} />
        </div>
        <pre className="code" tabIndex={0} role="region" aria-label={`${example.label} example test`}>
          <code>
            <span className="hot" ref={bar} aria-hidden="true" />
            {sample.lines.map((html, i) => (
              <span key={i} className="line" dangerouslySetInnerHTML={{ __html: html }} />
            ))}
          </code>
        </pre>
      </div>

      <div className="panel-mock">
        <div className="pane-head">
          <span className="url">
            <i aria-hidden="true" />
            {example.host}
          </span>
          <span className="spacer" />
          {controls}
        </div>
        <div className="mock" role="group" aria-label={`What the ${example.label} test produces`}>
          <Mock step={step} />
        </div>
        <ul className="checks" aria-label="What the test asserts">
          {example.checks.map((check) => (
            <li key={check.text} className={step >= check.step ? undefined : "is-pending"}>
              <Check size={13} />
              {check.text}
            </li>
          ))}
        </ul>
      </div>

      <div className="panel-note">
        <h3>
          <span className="nojs-label">{example.label}: </span>what channelstack handles
        </h3>
        <ul>
          {example.notes.map((note, n) => (
            <li key={n}>{note}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * One example per platform: the test on the left "plays" against the conversation it produces
 * on the right. Tabs follow the WAI-ARIA pattern (arrow keys, Home and End). Everything renders
 * finished, so it reads without script; without script every example shows, one after the other.
 */
export function Player() {
  const [active, setActive] = useState(0);
  const [step, setStep] = useState(() => doneOf(EXAMPLES[0]!));
  const [playing, setPlaying] = useState(false);
  const [root, inView] = useInView<HTMLDivElement>(0.3);
  const list = useRef<HTMLDivElement>(null);
  const ink = useRef<HTMLSpanElement>(null);
  const example = EXAMPLES[active]!;
  const done = doneOf(example);

  // Start once, when the player scrolls into view.
  useEffect(() => {
    if (!inView || prefersReducedMotion()) return;
    setStep(0);
    setPlaying(true);
  }, [inView]);

  useEffect(() => {
    if (!playing) return;
    if (step >= done) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setStep((s) => s + 1), step === 0 ? 500 : 1150);
    return () => clearTimeout(timer);
  }, [playing, step, done]);

  // The underline slides between tabs.
  useEffect(() => {
    const place = () => {
      const tab = list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[active];
      if (!tab || !ink.current) return;
      ink.current.style.transform = `translateX(${tab.offsetLeft}px) scaleX(${tab.offsetWidth / 100})`;
      ink.current.style.opacity = "1";
    };
    place();
    window.addEventListener("resize", place);
    document.fonts?.ready.then(place);
    return () => window.removeEventListener("resize", place);
  }, [active]);

  function select(index: number) {
    if (index === active) return;
    setActive(index);
    // A newly opened example plays from the start; with reduced motion it shows finished.
    const reduced = prefersReducedMotion();
    setStep(reduced ? doneOf(EXAMPLES[index]!) : 0);
    setPlaying(!reduced);
  }

  function onKeyDown(event: KeyboardEvent) {
    const last = EXAMPLES.length - 1;
    const next =
      event.key === "ArrowRight" ? (active === last ? 0 : active + 1)
      : event.key === "ArrowLeft" ? (active === 0 ? last : active - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : -1;
    if (next === -1) return;
    event.preventDefault();
    select(next);
    const tab = list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next];
    tab?.focus();
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function toggle() {
    if (playing) return setPlaying(false);
    if (step >= done) setStep(0);
    setPlaying(true);
  }

  const finished = step >= done;
  const controls = (
    <button type="button" className="replay" onClick={toggle}>
      {playing ? <Pause size={12} /> : finished ? <Replay size={12} /> : <Play size={12} />}
      {playing ? "Pause" : finished ? "Replay" : "Play"}
    </button>
  );

  return (
    <div className="player" id="examples" ref={root}>
      <h2 className="sr-only">Examples: one test per platform</h2>
      <div className="tabs" role="tablist" aria-label="Examples by platform" ref={list} onKeyDown={onKeyDown}>
        {EXAMPLES.map((item, i) => (
          <button key={item.id} type="button" role="tab" id={`tab-${item.id}`} aria-controls={`panel-${item.id}`} aria-selected={i === active} tabIndex={i === active ? 0 : -1} onClick={() => select(i)}>
            {item.label}
          </button>
        ))}
        <span className="tab-ink" ref={ink} aria-hidden="true" />
      </div>
      <div className="panels">
        {EXAMPLES.map((item, i) => (
          <Panel key={item.id} example={item} active={i === active} step={i === active ? step : doneOf(item)} controls={i === active ? controls : null} />
        ))}
      </div>
    </div>
  );
}
