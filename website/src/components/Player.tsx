import { type ComponentType, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import discordRs from "../../examples/rust/src/home_discord.rs?sample";
import githubRs from "../../examples/rust/src/home_github.rs?sample";
import gmailRs from "../../examples/rust/src/home_gmail.rs?sample";
import linearRs from "../../examples/rust/src/home_linear.rs?sample";
import notionRs from "../../examples/rust/src/home_notion.rs?sample";
import resendRs from "../../examples/rust/src/home_resend.rs?sample";
import slackRs from "../../examples/rust/src/home_slack.rs?sample";
import type { Sample } from "../../plugins/samples-plugin";
import discord from "../../samples/discord.test.ts?sample";
import github from "../../samples/github.test.ts?sample";
import gmail from "../../samples/gmail.test.ts?sample";
import slack from "../../samples/hero.test.ts?sample";
import linear from "../../samples/linear.test.ts?sample";
import notion from "../../samples/notion.test.ts?sample";
import discordPy from "../../samples/python/test_build.py?sample";
import notionPy from "../../samples/python/test_comments.py?sample";
import slackPy from "../../samples/python/test_deploy.py?sample";
import gmailPy from "../../samples/python/test_invoice.py?sample";
import githubPy from "../../samples/python/test_issues.py?sample";
import resendPy from "../../samples/python/test_refund.py?sample";
import linearPy from "../../samples/python/test_sessions.py?sample";
import resend from "../../samples/resend.test.ts?sample";
import { prefersReducedMotion, useInView } from "../lib/hooks";
import { CopyButton } from "./Code";
import { Check, Pause, Play, Replay } from "./Icons";
import {
  DiscordMock,
  GitHubMock,
  GmailMock,
  LinearMock,
  type MockProps,
  NotionMock,
  ResendMock,
  SlackMock,
} from "./Mocks";

type Lang = "ts" | "py" | "rs";
/** The language switch: each language's name, shortened on narrow screens, and its colour on GitHub. */
const LANGS: Array<{ id: Lang; name: string; short: string }> = [
  { id: "ts", name: "TypeScript", short: "TS" },
  { id: "py", name: "Python", short: "Py" },
  { id: "rs", name: "Rust", short: "Rs" },
];

interface Example {
  id: string;
  label: string;
  /** The address shown above the mock-up. */
  host: string;
  /** The same test in each language. Each carries the same playback steps. */
  code: Record<Lang, { file: string; sample: Sample }>;
  Mock: ComponentType<MockProps>;
  /** What the test asserts, each shown once playback reaches its step. */
  checks: Array<{ step: number; text: string }>;
  notes: ReactNode[];
}

const EXAMPLES: Example[] = [
  {
    id: "slack",
    label: "Slack",
    host: "slack.localhost",
    code: {
      ts: { file: "deploy.test.ts", sample: slack },
      py: { file: "test_deploy.py", sample: slackPy },
      rs: { file: "deploy.rs", sample: slackRs },
    },
    Mock: SlackMock,
    checks: [
      { step: 2, text: "status reads “checking CI”" },
      { step: 3, text: "the reply has an Approve button" },
      { step: 5, text: "“Deployed” appears once, no leftover “Thinking…”" },
    ],
    notes: [
      <>
        Delivers a signed <code>message.im</code> event to your app
      </>,
      <>
        Sends <code>block_actions</code> when Ana clicks Approve
      </>,
      <>Renders status lines and messages the way people see them</>,
    ],
  },
  {
    id: "github",
    label: "GitHub",
    host: "github.localhost",
    code: {
      ts: { file: "issues.test.ts", sample: github },
      py: { file: "test_issues.py", sample: githubPy },
      rs: { file: "issues.rs", sample: githubRs },
    },
    Mock: GitHubMock,
    checks: [
      { step: 3, text: "my-agent commented, mentioning Safari" },
      { step: 5, text: "one comment from my-agent after the redelivery" },
    ],
    notes: [
      <>
        Installs the App only on repos you list in <code>apps</code>
      </>,
      <>
        Signs each delivery with <code>X-Hub-Signature-256</code>
      </>,
      <>Redelivers with the same GUID, the way GitHub does</>,
    ],
  },
  {
    id: "linear",
    label: "Linear",
    host: "linear.localhost",
    code: {
      ts: { file: "sessions.test.ts", sample: linear },
      py: { file: "test_sessions.py", sample: linearPy },
      rs: { file: "sessions.rs", sample: linearRs },
    },
    Mock: LinearMock,
    checks: [
      { step: 3, text: "the session shows a thought" },
      { step: 5, text: "after Stop, the session is complete" },
    ],
    notes: [
      <>
        <code>AgentSessionEvent</code> in Linear’s current shape
      </>,
      <>
        The <code>prompted</code> event carrying the stop signal
      </>,
      <>Every GraphQL response checked against Linear’s schema</>,
    ],
  },
  {
    id: "notion",
    label: "Notion",
    host: "notion.localhost",
    code: {
      ts: { file: "comments.test.ts", sample: notion },
      py: { file: "test_comments.py", sample: notionPy },
      rs: { file: "comments.rs", sample: notionRs },
    },
    Mock: NotionMock,
    checks: [
      { step: 3, text: "my-agent answered in the same discussion" },
      { step: 4, text: "exactly one comment from my-agent" },
    ],
    notes: [
      <>Connections and their inheritance, like Notion</>,
      <>
        Webhooks signed with <code>X-Notion-Signature</code>
      </>,
      <>
        <code>page.content_updated</code> batched the way Notion does
      </>,
    ],
  },
  {
    id: "resend",
    label: "Resend",
    host: "resend.localhost",
    code: {
      ts: { file: "refund.test.ts", sample: resend },
      py: { file: "test_refund.py", sample: resendPy },
      rs: { file: "refund.rs", sample: resendRs },
    },
    Mock: ResendMock,
    checks: [
      { step: 2, text: "my-agent answered about the refund, in Ana’s thread" },
      { step: 4, text: "still one answer after Resend’s retry" },
    ],
    notes: [
      <>
        Delivers <code>email.received</code>, signed the Svix way
      </>,
      <>Serves the email back through the receiving API</>,
      <>
        Retries on Resend’s schedule, with the same <code>svix-id</code>
      </>,
    ],
  },
  {
    id: "gmail",
    label: "Gmail",
    host: "google.localhost",
    code: {
      ts: { file: "invoice.test.ts", sample: gmail },
      py: { file: "test_invoice.py", sample: gmailPy },
      rs: { file: "invoice.rs", sample: gmailRs },
    },
    Mock: GmailMock,
    checks: [
      { step: 3, text: "the answer is “Re: Invoice”, in Ana’s thread" },
      { step: 4, text: "exactly one answer from my-agent" },
    ],
    notes: [
      <>Pushes a Pub/Sub message with an OIDC token your app verifies</>,
      <>
        Serves <code>history.list</code> and <code>messages.get</code> from the mailbox
      </>,
      <>
        Threads <code>messages.send</code> by <code>threadId</code> and <code>In-Reply-To</code>
      </>,
    ],
  },
  {
    id: "discord",
    label: "Discord",
    host: "discord.localhost",
    code: {
      ts: { file: "build.test.ts", sample: discord },
      py: { file: "test_build.py", sample: discordPy },
      rs: { file: "build.rs", sample: discordRs },
    },
    Mock: DiscordMock,
    checks: [
      { step: 3, text: "my-agent’s answer is Discord’s reply to Ana’s message" },
      { step: 4, text: "exactly one answer from my-agent" },
    ],
    notes: [
      <>
        Dispatches <code>MESSAGE_CREATE</code> over the Gateway, with its content under <code>MESSAGE_CONTENT</code>
      </>,
      <>Serves REST v10 as discord.js calls it, with Discord’s rate limits and error codes</>,
      <>Signs slash commands with Ed25519, and gives up on them after 3 seconds</>,
    ],
  },
];

/** The step after the last tagged line or check: the finished run. */
const doneOf = (example: Example) =>
  Math.max(...example.code.ts.sample.steps, ...example.checks.map((c) => c.step)) + 1;

function Panel({
  example,
  active,
  step,
  lang,
  onLang,
  controls,
}: {
  example: Example;
  active: boolean;
  step: number;
  lang: Lang;
  onLang: (lang: Lang) => void;
  controls: ReactNode;
}) {
  const bar = useRef<HTMLSpanElement>(null);
  const { Mock } = example;
  const { file, sample } = example.code[lang];

  // The highlight bar moves with transform only. It is positioned here, not with a style
  // attribute, so the prerendered HTML carries no inline styles.
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const pre = el.closest("pre");
    const first = sample.steps.indexOf(step);
    if (!active || step < 1 || first === -1) {
      el.style.opacity = "0";
      if (pre && step < 1) pre.scrollTop = 0;
      return;
    }
    const rows = sample.steps.filter((s) => s === step).length;
    el.style.opacity = "1";
    el.style.transform = `translateY(calc(${first} * var(--code-lh))) scaleY(${rows})`;
    // Code taller than its panel scrolls: keep the lines being played in the middle of it.
    if (pre && pre.scrollHeight > pre.clientHeight) {
      const lines = pre.querySelectorAll<HTMLElement>(".line");
      const top = lines[first]?.offsetTop ?? 0;
      const last = lines[first + rows - 1];
      const bottom = last ? last.offsetTop + last.offsetHeight : top;
      const target = top - (pre.clientHeight - (bottom - top)) / 2;
      pre.scrollTo({ top: Math.max(0, target), behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
  }, [active, step, sample]);

  return (
    <div
      className={active ? "panel is-active" : "panel"}
      role="tabpanel"
      id={`panel-${example.id}`}
      aria-labelledby={`tab-${example.id}`}
    >
      <div className="panel-code">
        <div className="pane-head">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>{file}</span>
          <span className="spacer" />
          <span className="lang" role="group" aria-label="Language">
            {LANGS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id}
                aria-pressed={item.id === lang}
                aria-label={item.name}
                onClick={() => onLang(item.id)}
              >
                <i aria-hidden="true" />
                <span className="full">{item.name}</span>
                <span className="short" aria-hidden="true">
                  {item.short}
                </span>
              </button>
            ))}
          </span>
          <CopyButton text={sample.code} label={`Copy the ${example.label} example`} />
        </div>
        <pre
          className="code"
          tabIndex={0}
          role="region"
          aria-label={`${example.label} example test in ${LANGS.find((item) => item.id === lang)?.name}`}
        >
          <code>
            <span className="hot" ref={bar} aria-hidden="true" />
            {sample.lines.map((html, i) => (
              // biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted HTML built from our own sample files
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
 * One example per platform, in TypeScript or Python: the test on the left "plays" against the conversation it produces
 * on the right. Tabs follow the WAI-ARIA pattern (arrow keys, Home and End). Everything renders
 * finished, so it reads without script; without script every example shows, one after the other.
 */
export function Player() {
  const [active, setActive] = useState(0);
  const [step, setStep] = useState(() => doneOf(EXAMPLES[0]!));
  const [playing, setPlaying] = useState(false);
  const [lang, setLang] = useState<Lang>("ts");
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
      event.key === "ArrowRight"
        ? active === last
          ? 0
          : active + 1
        : event.key === "ArrowLeft"
          ? active === 0
            ? last
            : active - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
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
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-controls={`panel-${item.id}`}
            aria-selected={i === active}
            tabIndex={i === active ? 0 : -1}
            onClick={() => select(i)}
          >
            {item.label}
          </button>
        ))}
        <span className="tab-ink" ref={ink} aria-hidden="true" />
      </div>
      <div className="panels">
        {EXAMPLES.map((item, i) => (
          <Panel
            key={item.id}
            example={item}
            active={i === active}
            lang={lang}
            onLang={setLang}
            step={i === active ? step : doneOf(item)}
            controls={i === active ? controls : null}
          />
        ))}
      </div>
    </div>
  );
}
