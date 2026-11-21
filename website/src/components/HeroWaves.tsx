import { useEffect, useRef } from "react";
import { prefersReducedMotion, runWhileVisible } from "../lib/hooks";

/**
 * Hero decoration: two voices taking turns. A person speaks (grey bars, left of centre), the
 * agent answers (amber bars, right of centre), and so on: the conversation channelstack tests.
 * It renders as a still waveform; script animates each bar's scaleY, so it runs on transform and
 * opacity only. Hidden on narrow screens and from assistive technology.
 */
const COUNT = 54;
const STEP = 9;
const HEIGHT = 160;
const MID = HEIGHT / 2;
const CYCLE = 4400;
/** Each voice speaks during its own part of the cycle, with a short silence between turns. */
const TURNS = { person: [0.03, 0.44], agent: [0.53, 0.94] } as const;
const FRAMES = 11;

const noise = (n: number) => Math.abs(Math.sin(n * 12.9898 + 78.233) * 43758.5453) % 1;
/** How loud a voice can get at bar `i`: a bell around the voice's side of the picture. */
const reach = (i: number, centre: number) => Math.exp(-Math.pow((i / (COUNT - 1) - centre) / 0.2, 2));

const VOICES = [
  { id: "person", centre: 0.36, seed: 1 },
  { id: "agent", centre: 0.64, seed: 2 },
] as const;

/** The still pose: both voices mid-word. */
const pose = (i: number, centre: number, seed: number) => Math.max(3, Math.round(HEIGHT * 0.86 * reach(i, centre) * (0.45 + 0.55 * noise(i * 7 + seed))));

export function HeroWaves() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== "function" || typeof IntersectionObserver === "undefined") return;
    if (getComputedStyle(el).display === "none") return;
    const animations: Animation[] = [];
    const timing = { duration: CYCLE, iterations: Infinity } as const;

    for (const voice of VOICES) {
      const [from, to] = TURNS[voice.id];
      el.querySelectorAll<SVGRectElement>(`.voice-${voice.id} rect`).forEach((rect, i) => {
        const rest = 3 / Number(rect.getAttribute("height"));
        // Silence, then a run of quick syllables that ripples outwards from the voice's centre, then silence.
        const delay = Math.abs(i / (COUNT - 1) - voice.centre) * 0.12;
        const frames: Keyframe[] = [{ transform: `scaleY(${rest})`, offset: 0 }, { transform: `scaleY(${rest})`, offset: from + delay }];
        for (let f = 1; f <= FRAMES; f++) {
          const offset = from + delay + ((to - from - 0.12) * f) / (FRAMES + 1);
          const loud = 0.25 + 1.05 * noise(i * 13 + f * 29 + voice.seed * 101);
          frames.push({ transform: `scaleY(${loud.toFixed(2)})`, offset, easing: "ease-in-out" });
        }
        frames.push({ transform: `scaleY(${rest})`, offset: to }, { transform: `scaleY(${rest})`, offset: 1 });
        animations.push(rect.animate(frames, timing));
      });

      // The speaker's name lights up for the length of its turn.
      const label = el.querySelector(`.speaker-${voice.id}`);
      if (label) {
        animations.push(
          label.animate(
            [
              { opacity: 0.35, offset: 0 },
              { opacity: 0.35, offset: Math.max(0, from - 0.02) },
              { opacity: 1, offset: from + 0.04 },
              { opacity: 1, offset: to - 0.04 },
              { opacity: 0.35, offset: Math.min(1, to + 0.02) },
              { opacity: 0.35, offset: 1 },
            ],
            timing,
          ),
        );
      }
    }

    return runWhileVisible(el, animations);
  }, []);

  return (
    <div className="hero-waves" ref={root} aria-hidden="true">
      <svg viewBox={`0 0 ${COUNT * STEP} ${HEIGHT}`} focusable="false">
        {VOICES.map((voice) => (
          <g key={voice.id} className={`voice-${voice.id}`}>
            {Array.from({ length: COUNT }, (_, i) => {
              const h = pose(i, voice.centre, voice.seed);
              return <rect key={i} x={i * STEP + 3} y={MID - h / 2} width="3" height={h} rx="1.5" />;
            })}
          </g>
        ))}
      </svg>
      <p className="speakers">
        <span className="speaker-person">
          <i /> ana
        </span>
        <span className="speaker-agent">
          <i /> robin
        </span>
      </p>
    </div>
  );
}
