import { useEffect, useRef, useState } from "react";
import hero from "../../samples/hero.test.ts?sample";
import { prefersReducedMotion, useInView } from "../lib/hooks";
import { Check, Pause, Play, Replay } from "./Icons";

/** Steps 1–5 are the tagged lines of the hero test; DONE shows the finished run. */
const DONE = 6;

const CUES = [
  { step: 1, time: "00:00.000", dir: "→ agent", text: "message.im · v0 signature · retry 0", result: "200" },
  { step: 2, time: "00:00.391", dir: "← agent", text: "assistant.threads.setStatus", result: "✓" },
  { step: 3, time: "00:01.204", dir: "← agent", text: "chat.postMessage · 2 blocks", result: "✓" },
  { step: 4, time: "00:01.950", dir: "→ agent", text: "block_actions · approve", result: "200" },
  { step: 5, time: "00:02.733", dir: "← agent", text: "chat.postMessage", result: "✓" },
];

/**
 * The hero test "plays" against the conversation it produces. It renders finished, so it
 * reads without script; playback starts once, when the stage scrolls into view.
 */
export function Stage() {
  const [step, setStep] = useState(DONE);
  const [playing, setPlaying] = useState(false);
  const [stage, inView] = useInView<HTMLDivElement>(0.3);
  const bar = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!inView || prefersReducedMotion()) return;
    setStep(0);
    setPlaying(true);
  }, [inView]);

  useEffect(() => {
    if (!playing) return;
    if (step >= DONE) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setStep((s) => s + 1), step === 0 ? 500 : 1150);
    return () => clearTimeout(timer);
  }, [playing, step]);

  // The highlight bar moves with transform only; it is positioned here rather than with a
  // style attribute so the prerendered HTML carries no inline styles.
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const first = hero.steps.indexOf(step);
    if (first === -1) {
      el.style.opacity = "0";
      return;
    }
    const rows = hero.steps.filter((s) => s === step).length;
    el.style.opacity = "1";
    el.style.transform = `translateY(calc(${first} * var(--code-lh))) scaleY(${rows})`;
  }, [step]);

  function toggle() {
    if (playing) return setPlaying(false);
    if (step >= DONE) setStep(0);
    setPlaying(true);
  }

  const done = step >= DONE;
  const at = (n: number) => (step >= n ? undefined : "is-pending");
  const label = playing ? "Pause" : done ? "Replay" : "Play";

  return (
    <div className="stage" ref={stage}>
      <div className="pane pane-code">
        <div className="pane-head">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>deploy.test.ts</span>
          <span className="spacer" />
          <span>vitest</span>
        </div>
        <pre className="code" tabIndex={0} role="region" aria-label="Example test: ships a PR from a Slack DM">
          <code>
            <span className="hot" ref={bar} aria-hidden="true" />
            {hero.lines.map((html, i) => (
              <span key={i} className="line" dangerouslySetInnerHTML={{ __html: html }} />
            ))}
          </code>
        </pre>
      </div>

      <div className="pane pane-monitor">
        <div className="pane-head">
          <span className="chan">ana ↔ robin</span>
          <span className="tag">slack.localhost</span>
          <span className="spacer" />
          <button type="button" className="replay" onClick={toggle}>
            {playing ? <Pause size={12} /> : done ? <Replay size={12} /> : <Play size={12} />}
            {label}
          </button>
        </div>

        <div className="thread" role="group" aria-label="The conversation the test produces">
          <div className={`msg ${at(1) ?? ""}`}>
            <span className="avatar ana" aria-hidden="true">A</span>
            <div>
              <p className="who">
                ana <small>10:42</small>
              </p>
              <p>
                <span className="mention">@robin</span> ship #812 to staging
              </p>
            </div>
          </div>

          <div className="slot">
            <p className={`status ${step === 2 ? "" : "is-pending"}`} aria-hidden={step !== 2}>
              <span className="avatar bot" aria-hidden="true">R</span>
              <span>
                <b>robin</b> is checking CI on #812
                <span className="ellipsis" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
            </p>
            <div className={`msg ${at(3) ?? ""}`}>
              <span className="avatar bot" aria-hidden="true">R</span>
              <div>
                <p className="who">
                  robin <span className="tag">APP</span> <small>10:42</small>
                </p>
                <p>Deploy #812 to staging? CI passed 4 minutes ago, 2 files changed.</p>
                <p className="buttons">
                  <span className={`sbtn go ${step >= 4 ? "is-clicked" : ""}`}>
                    <Check size={13} className="tick" />
                    Approve
                  </span>
                  <span className="sbtn">Cancel</span>
                </p>
              </div>
            </div>
          </div>

          <div className={`msg ${at(5) ?? ""}`}>
            <span className="avatar bot" aria-hidden="true">R</span>
            <div>
              <p className="who">
                robin <span className="tag">APP</span> <small>10:43</small>
              </p>
              <p>Deployed #812 to staging in 41s. ana approved it.</p>
            </div>
          </div>
        </div>

        <div className="cues">
          <p className="cues-head">
            <span>Cue sheet</span>
            <span>schema-checked</span>
          </p>
          <ol aria-label="Every request recorded during the test">
            {CUES.map((cue) => (
              <li key={cue.step} className={`cue ${at(cue.step) ?? ""}`}>
                <span className="time">{cue.time}</span>
                <span className="dir">{cue.dir}</span>
                <span className="what">{cue.text}</span>
                <span className="res">{cue.result}</span>
              </li>
            ))}
          </ol>
          <p className={`result ${done ? "" : "is-pending"}`}>
            <span className="badge">PASS</span>
            <span>5 assertions · 2.7s · 0 unknown requests</span>
          </p>
        </div>
      </div>
    </div>
  );
}
