import { useEffect, useRef } from "react";
import { prefersReducedMotion, runWhileVisible } from "../lib/hooks";

/**
 * Hero decoration: two voices taking turns, the conversation channelstack tests. A person asks
 * (grey bars, left of centre), a dot carries the message across, the agent answers at more length
 * (amber bars, right of centre), and a dot carries the answer back. Each voice has a fainter echo
 * that trails it. It renders as a still waveform; script animates scaleY, translateX and opacity
 * only. Hidden on narrow screens and from assistive technology.
 */
const COUNT = 60;
const STEP = 8;
const HEIGHT = 170;
const MID = HEIGHT / 2;
const CYCLE = 5200;

const VOICES = [
  { id: "person", centre: 0.35, seed: 1, from: 0.03, to: 0.33, syllables: 7 },
  { id: "agent", centre: 0.65, seed: 2, from: 0.45, to: 0.89, syllables: 12 },
] as const;

/** The message crossing between the voices, in the silences. */
const HANDOFFS = [
  { id: "ask", from: 0.33, to: 0.45, start: 0.35, end: 0.65 },
  { id: "answer", from: 0.89, to: 0.99, start: 0.65, end: 0.35 },
] as const;

const noise = (n: number) => Math.abs(Math.sin(n * 12.9898 + 78.233) * 43758.5453) % 1;
/** How loud a voice can get at bar `i`: a bell around the voice's side of the picture. */
const reach = (i: number, centre: number) => Math.exp(-Math.pow((i / (COUNT - 1) - centre) / 0.17, 2));
/** The still pose: both voices mid-word. */
const pose = (i: number, centre: number, seed: number) => Math.max(3, Math.round(HEIGHT * 0.9 * reach(i, centre) * (0.5 + 0.5 * noise(i * 7 + seed))));

/** Keyframes for one bar: silence, a run of syllables that spreads out from the voice's centre, silence. */
function speak(i: number, height: number, voice: (typeof VOICES)[number], lag: number, gain: number): Keyframe[] {
  const rest = `scaleY(${(3 / height).toFixed(3)})`;
  const spread = Math.abs(i / (COUNT - 1) - voice.centre) * 0.1;
  const start = voice.from + spread + lag;
  const span = voice.to - voice.from - 0.1;
  const frames: Keyframe[] = [{ transform: rest, offset: 0 }, { transform: rest, offset: start, easing: "cubic-bezier(0.3, 0, 0.2, 1)" }];
  for (let s = 0; s < voice.syllables; s++) {
    // Every bar shares the syllable's loudness, so the voice moves as one; each bar adds its own grain.
    const syllable = 0.45 + 0.75 * noise(s * 17 + voice.seed * 53);
    const grain = 0.7 + 0.3 * noise(i * 13 + s * 29 + voice.seed * 101);
    const peak = start + (span * (s + 0.5)) / voice.syllables;
    const dip = start + (span * (s + 1)) / voice.syllables;
    frames.push({ transform: `scaleY(${(gain * syllable * grain).toFixed(2)})`, offset: peak, easing: "ease-in-out" });
    if (s < voice.syllables - 1) frames.push({ transform: `scaleY(${(gain * 0.28 * grain).toFixed(2)})`, offset: dip, easing: "ease-in-out" });
  }
  frames.push({ transform: rest, offset: Math.min(0.995, voice.to + spread * 0.5 + lag) }, { transform: rest, offset: 1 });
  return frames;
}

export function HeroWaves() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== "function" || typeof IntersectionObserver === "undefined") return;
    if (getComputedStyle(el).display === "none") return;
    const animations: Animation[] = [];
    const timing = { duration: CYCLE, iterations: Infinity } as const;

    for (const voice of VOICES) {
      for (const [layer, lag, gain] of [["voice", 0, 1.12], ["echo", 0.024, 1.3]] as const) {
        el.querySelectorAll<SVGRectElement>(`.${layer}-${voice.id} rect`).forEach((rect, i) => {
          animations.push(rect.animate(speak(i, Number(rect.getAttribute("height")), voice, lag, gain), timing));
        });
      }
      // The speaker's name lights up for the length of its turn.
      const label = el.querySelector(`.speaker-${voice.id}`);
      if (label) {
        animations.push(
          label.animate(
            [
              { opacity: 0.4, offset: 0 },
              { opacity: 0.4, offset: Math.max(0, voice.from - 0.02) },
              { opacity: 1, offset: voice.from + 0.04 },
              { opacity: 1, offset: voice.to - 0.03 },
              { opacity: 0.4, offset: Math.min(1, voice.to + 0.03) },
              { opacity: 0.4, offset: 1 },
            ],
            timing,
          ),
        );
      }
    }

    for (const handoff of HANDOFFS) {
      const dot = el.querySelector(`.handoff-${handoff.id}`);
      if (!dot) continue;
      const at = (x: number) => `translateX(${(x * 100).toFixed(1)}%)`;
      animations.push(
        dot.animate(
          [
            { opacity: 0, transform: at(handoff.start), offset: 0 },
            { opacity: 0, transform: at(handoff.start), offset: handoff.from, easing: "cubic-bezier(0.5, 0, 0.2, 1)" },
            { opacity: 1, transform: at(handoff.start + (handoff.end - handoff.start) * 0.2), offset: handoff.from + (handoff.to - handoff.from) * 0.25, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
            { opacity: 1, transform: at(handoff.start + (handoff.end - handoff.start) * 0.85), offset: handoff.from + (handoff.to - handoff.from) * 0.8 },
            { opacity: 0, transform: at(handoff.end), offset: handoff.to },
            { opacity: 0, transform: at(handoff.end), offset: 1 },
          ],
          timing,
        ),
      );
    }

    return runWhileVisible(el, animations);
  }, []);

  return (
    <div className="hero-waves" ref={root} aria-hidden="true">
      <div className="wave-box">
        <svg viewBox={`0 0 ${COUNT * STEP} ${HEIGHT}`} focusable="false">
          {VOICES.flatMap((voice) =>
            (["echo", "voice"] as const).map((layer) => (
              <g key={`${layer}-${voice.id}`} className={`${layer}-${voice.id}`}>
                {Array.from({ length: COUNT }, (_, i) => {
                  const h = pose(i, voice.centre, voice.seed);
                  return <rect key={i} x={i * STEP + 2.75} y={MID - h / 2} width="2.5" height={h} rx="1.25" />;
                })}
              </g>
            )),
          )}
        </svg>
        {HANDOFFS.map((handoff) => (
          <span key={handoff.id} className={`handoff handoff-${handoff.id}`}>
            <i />
          </span>
        ))}
      </div>
      <p className="speakers">
        <span className="speaker-person">
          <i>A</i> ana
        </span>
        <span className="speaker-agent">
          <i>R</i> robin
        </span>
      </p>
    </div>
  );
}
