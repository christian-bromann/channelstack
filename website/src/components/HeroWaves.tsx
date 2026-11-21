import { useEffect, useRef } from "react";

import { prefersReducedMotion, runWhileVisible } from "../lib/hooks";

/**
 * Hero decoration: two voices taking turns, the conversation channelstack tests. A person asks
 * (grey bars, left of centre), a dot carries the message across, the agent answers at more length
 * (amber bars, right of centre), and a dot carries the answer back. One loop holds two exchanges. Each voice has a fainter echo
 * that trails it. It renders as a still waveform; script animates scaleY, translateX and opacity
 * only. Hidden on narrow screens and from assistive technology.
 */
const COUNT = 60;
const STEP = 8;
const HEIGHT = 170;
const MID = HEIGHT / 2;
/** One loop holds two exchanges, so the same phrase doesn't come round every few seconds. */
const CYCLE = 10800;

const VOICES = [
  { id: "person", centre: 0.35, seed: 1 },
  { id: "agent", centre: 0.65, seed: 2 },
] as const;
type VoiceId = (typeof VOICES)[number]["id"];

/** Who speaks when (as fractions of the loop), and for how many syllables. */
const TURNS: Array<{ voice: VoiceId; from: number; to: number; syllables: number; seed: number }> = [
  { voice: "person", from: 0.015, to: 0.165, syllables: 7, seed: 11 },
  { voice: "agent", from: 0.225, to: 0.44, syllables: 11, seed: 23 },
  { voice: "person", from: 0.515, to: 0.625, syllables: 5, seed: 37 },
  { voice: "agent", from: 0.685, to: 0.94, syllables: 13, seed: 41 },
];

/** The message crossing between the voices, in the silence after each turn. */
const HANDOFFS = TURNS.map((turn, n) => {
  const next = TURNS[(n + 1) % TURNS.length]!;
  const toAgent = turn.voice === "person";
  return {
    toAgent,
    from: turn.to - 0.012,
    to: n === TURNS.length - 1 ? 0.998 : next.from + 0.012,
    start: toAgent ? 0.35 : 0.65,
    end: toAgent ? 0.65 : 0.35,
  };
});

const noise = (n: number) => Math.abs(Math.sin(n * 12.9898 + 78.233) * 43758.5453) % 1;
/** How loud a voice can get at bar `i`: a bell around the voice's side of the picture. */
const reach = (i: number, centre: number) => Math.exp(-(((i / (COUNT - 1) - centre) / 0.17) ** 2));
/** The still pose: both voices mid-word. */
const pose = (i: number, centre: number, seed: number) =>
  Math.max(3, Math.round(HEIGHT * 0.9 * reach(i, centre) * (0.5 + 0.5 * noise(i * 7 + seed))));

/**
 * Keyframes for one bar across all of its voice's turns. A turn starts softly, runs through its
 * syllables, and trails off: the last syllables get quieter and the bar settles from the final,
 * small one, so a turn never ends by collapsing from full height.
 */
function speak(i: number, height: number, voice: (typeof VOICES)[number], lag: number, gain: number): Keyframe[] {
  const rest = `scaleY(${(3 / height).toFixed(3)})`;
  const spread = Math.abs(i / (COUNT - 1) - voice.centre) * 0.05;
  const frames: Keyframe[] = [{ transform: rest, offset: 0 }];
  for (const turn of TURNS) {
    if (turn.voice !== voice.id) continue;
    const start = turn.from + spread + lag;
    const beat = (turn.to - turn.from - 0.05) / turn.syllables;
    frames.push({ transform: rest, offset: start, easing: "cubic-bezier(0.3, 0, 0.2, 1)" });
    for (let s = 0; s < turn.syllables; s++) {
      const left = turn.syllables - 1 - s;
      // loud in the middle of the turn, soft at its start, fading over its last three syllables
      const shape = Math.min(1, 0.55 + 0.45 * s) * (left === 0 ? 0.3 : left === 1 ? 0.55 : left === 2 ? 0.8 : 1);
      // every bar shares the syllable's loudness, so the voice moves as one; each bar adds its own grain
      const syllable = 0.5 + 0.7 * noise(s * 17 + turn.seed * 53);
      const grain = 0.7 + 0.3 * noise(i * 13 + s * 29 + turn.seed * 101);
      const level = gain * shape * syllable * grain;
      frames.push({
        transform: `scaleY(${level.toFixed(2)})`,
        offset: start + beat * (s + 0.5),
        easing: "ease-in-out",
      });
      if (left > 0)
        frames.push({
          transform: `scaleY(${(level * 0.32).toFixed(2)})`,
          offset: start + beat * (s + 1),
          easing: "ease-in-out",
        });
    }
    // settle within one beat of the last, quiet syllable
    frames.push({ transform: rest, offset: start + beat * (turn.syllables + 0.6) });
  }
  frames.push({ transform: rest, offset: 1 });
  return frames;
}

export function HeroWaves() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (
      !el ||
      prefersReducedMotion() ||
      typeof el.animate !== "function" ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    if (getComputedStyle(el).display === "none") return;
    const animations: Animation[] = [];
    const timing = { duration: CYCLE, iterations: Infinity } as const;

    for (const voice of VOICES) {
      for (const [layer, lag, gain] of [
        ["voice", 0, 1.12],
        ["echo", 0.012, 1.3],
      ] as const) {
        el.querySelectorAll<SVGRectElement>(`.${layer}-${voice.id} rect`).forEach((rect, i) => {
          animations.push(rect.animate(speak(i, Number(rect.getAttribute("height")), voice, lag, gain), timing));
        });
      }
      // The speaker's name lights up for the length of each of its turns.
      const label = el.querySelector(`.speaker-${voice.id}`);
      if (label) {
        const frames: Keyframe[] = [{ opacity: 0.4, offset: 0 }];
        for (const turn of TURNS) {
          if (turn.voice !== voice.id) continue;
          frames.push(
            { opacity: 0.4, offset: turn.from },
            { opacity: 1, offset: turn.from + 0.02 },
            { opacity: 1, offset: turn.to - 0.02 },
            { opacity: 0.4, offset: turn.to },
          );
        }
        frames.push({ opacity: 0.4, offset: 1 });
        animations.push(label.animate(frames, timing));
      }
    }

    for (const toAgent of [true, false]) {
      const dot = el.querySelector(toAgent ? ".handoff-ask" : ".handoff-answer");
      if (!dot) continue;
      const at = (x: number) => `translateX(${(x * 100).toFixed(1)}%)`;
      const frames: Keyframe[] = [];
      let last = toAgent ? 0.35 : 0.65;
      frames.push({ opacity: 0, transform: at(last), offset: 0 });
      for (const handoff of HANDOFFS) {
        if (handoff.toAgent !== toAgent) continue;
        const length = handoff.to - handoff.from;
        const travel = handoff.end - handoff.start;
        frames.push(
          { opacity: 0, transform: at(handoff.start), offset: handoff.from, easing: "cubic-bezier(0.5, 0, 0.2, 1)" },
          {
            opacity: 1,
            transform: at(handoff.start + travel * 0.2),
            offset: handoff.from + length * 0.25,
            easing: "cubic-bezier(0.4, 0, 0.2, 1)",
          },
          { opacity: 1, transform: at(handoff.start + travel * 0.85), offset: handoff.from + length * 0.8 },
          { opacity: 0, transform: at(handoff.end), offset: handoff.to },
        );
        last = handoff.end;
      }
      frames.push({ opacity: 0, transform: at(last), offset: 1 });
      animations.push(dot.animate(frames, timing));
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
        <span className="handoff handoff-ask">
          <i />
        </span>
        <span className="handoff handoff-answer">
          <i />
        </span>
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
