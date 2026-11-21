import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import github from "../../samples/github.test.ts?sample";
import linear from "../../samples/linear.test.ts?sample";
import live from "../../samples/live.test.ts?sample";
import notion from "../../samples/notion.test.ts?sample";
import slack from "../../samples/slack.test.ts?sample";
import pytest from "../../samples/test_keys.py?sample";
import type { Sample } from "../../build/samples-plugin";
import { Code, CopyButton } from "./Code";

interface Example {
  id: string;
  label: string;
  file: string;
  sample: Sample;
  notes: ReactNode[];
}

const EXAMPLES: Example[] = [
  {
    id: "slack",
    label: "Slack",
    file: "mentions.test.ts",
    sample: slack,
    notes: [
      <>Delivers a signed <code>app_mention</code> event to your agent</>,
      <>Waits until the thread has been quiet before counting replies</>,
      <>Fails on a stray message in the channel, outside the thread</>,
    ],
  },
  {
    id: "github",
    label: "GitHub",
    file: "issues.test.ts",
    sample: github,
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
    sample: linear,
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
    sample: notion,
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
    sample: live,
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
    sample: pytest,
    notes: [
      <>The same fakes from Python through <code>pytest-channelstack</code></>,
      <>One channelstack server shared by JS and Python suites</>,
      <>Fixtures named after each platform</>,
    ],
  },
];

/**
 * Tabs following the WAI-ARIA pattern: arrow keys, Home and End move between tabs.
 * Without script every example shows, one after the other (see `.js` in home.css).
 */
export function Examples() {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const ink = useRef<HTMLSpanElement>(null);

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
    setActive(next);
    const tab = list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next];
    tab?.focus();
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  return (
    <div className="examples">
      <div className="tabs" role="tablist" aria-label="Examples" ref={list} onKeyDown={onKeyDown}>
        {EXAMPLES.map((example, i) => (
          <button key={example.id} type="button" role="tab" id={`tab-${example.id}`} aria-controls={`panel-${example.id}`} aria-selected={i === active} tabIndex={i === active ? 0 : -1} onClick={() => setActive(i)}>
            {example.label}
          </button>
        ))}
        <span className="tab-ink" ref={ink} aria-hidden="true" />
      </div>
      <div className="panels">
        {EXAMPLES.map((example, i) => (
          <div key={example.id} className={i === active ? "panel is-active" : "panel"} role="tabpanel" id={`panel-${example.id}`} aria-labelledby={`tab-${example.id}`}>
            <div className="panel-code">
              <div className="pane-head">
                <span>{example.file}</span>
                <span className="spacer" />
                <CopyButton text={example.sample.code} label={`Copy the ${example.label} example`} />
              </div>
              <Code sample={example.sample} label={`${example.label} example`} />
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
        ))}
      </div>
    </div>
  );
}
