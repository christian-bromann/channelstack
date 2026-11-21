import { useEffect, useRef } from "react";

import { prefersReducedMotion, runWhileVisible } from "../lib/hooks";

/**
 * The waveform of someone saying "channelstack": a burst for "ch", loud vowels, a quiet
 * nasal, the hiss of "s", and short silences before the stops "t" and "ck".
 * Each segment is [bars, loudness 0–1, texture, voiced].
 */
type Texture = "silence" | "burst" | "vowel" | "nasal" | "hiss" | "decay";
const SEGMENTS: Array<[number, number, Texture, boolean]> = [
  [6, 0.04, "silence", false],
  [7, 0.5, "burst", false], // ch
  [17, 0.95, "vowel", true], // a
  [10, 0.42, "nasal", false], // n
  [9, 0.62, "vowel", true], // e
  [8, 0.4, "nasal", false], // l
  [3, 0.05, "silence", false],
  [14, 0.34, "hiss", false], // s
  [4, 0.04, "silence", false], // t (closure)
  [3, 0.6, "burst", false], // t (release)
  [19, 1, "vowel", true], // a
  [5, 0.04, "silence", false], // ck (closure)
  [4, 0.55, "burst", false], // ck (release)
  [5, 0.3, "decay", false],
  [6, 0.04, "silence", false],
];

const noise = (i: number) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;

const BARS = SEGMENTS.flatMap(([count, level, texture, voiced], s) =>
  Array.from({ length: count }, (_, k) => {
    const t = count === 1 ? 0.5 : k / (count - 1);
    const n = noise(s * 31 + k);
    const shape =
      texture === "vowel"
        ? Math.sin(Math.PI * (0.08 + 0.84 * t)) ** 0.45 * (0.82 + 0.18 * Math.cos(k * 1.9))
        : texture === "nasal"
          ? 0.8 + 0.2 * Math.sin(Math.PI * t)
          : texture === "hiss"
            ? 0.55 + 0.45 * n
            : texture === "burst"
              ? 1 - 0.55 * t + 0.2 * n
              : texture === "decay"
                ? 1 - 0.8 * t
                : 1;
    return { height: Math.max(2, Math.round(60 * level * shape)), voiced };
  }),
);

const TOTAL = BARS.length;
const STEP = 5;
const CYCLE = 6400;

/** The three syllables: which bars they cover and when in the loop they are spoken. */
const SYLLABLES = [
  { text: "chan", bars: 40, from: 0.05, to: 0.22 },
  { text: "nel", bars: 20, from: 0.25, to: 0.34 },
  { text: "stack", bars: 60, from: 0.38, to: 0.62 },
];
const HOLD = 0.86;

/** When bar `i` is spoken, as a fraction of the loop: steady within a syllable, with a breath between syllables. */
function spokenAt(i: number) {
  let first = 0;
  for (const syllable of SYLLABLES) {
    if (i < first + syllable.bars) return syllable.from + ((i - first) / syllable.bars) * (syllable.to - syllable.from);
    first += syllable.bars;
  }
  return SYLLABLES[SYLLABLES.length - 1]!.to;
}

export function Voice() {
  const root = useRef<HTMLDivElement>(null);

  // The word is "spoken" from left to right: a playhead crosses the wave, each bar jumps up as
  // it passes and settles into the recording, and each syllable's label lights up in turn. Then
  // the wave rests, sinks back and the word is said again. The Web Animations API keeps this on
  // transform and opacity, and needs no inline styles.
  useEffect(() => {
    const el = root.current;
    if (
      !el ||
      prefersReducedMotion() ||
      typeof el.animate !== "function" ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const timing = { duration: CYCLE, iterations: Infinity } as const;
    const animations: Animation[] = [];

    el.querySelectorAll("rect").forEach((rect, i) => {
      const at = spokenAt(i);
      const out = HOLD + (i / TOTAL) * 0.05;
      const quiet = { transform: "scaleY(0.12)", opacity: 0.3 };
      animations.push(
        rect.animate(
          [
            { ...quiet, offset: 0 },
            { ...quiet, offset: Math.max(0, at - 0.012), easing: "cubic-bezier(0.2, 0.9, 0.3, 1)" },
            { transform: "scaleY(1.3)", opacity: 1, offset: at + 0.012, easing: "ease-in-out" },
            { transform: "scaleY(0.88)", opacity: 1, offset: at + 0.035, easing: "ease-in-out" },
            { transform: "scaleY(1)", opacity: 1, offset: at + 0.06 },
            { transform: "scaleY(1)", opacity: 1, offset: out, easing: "cubic-bezier(0.5, 0, 0.7, 0.4)" },
            { ...quiet, offset: out + 0.06 },
            { ...quiet, offset: 1 },
          ],
          timing,
        ),
      );
    });

    // The playhead keeps pace with the bars, pausing for the breath between syllables.
    const head = el.querySelector(".playhead");
    if (head) {
      const x = (bars: number) => `translateX(${((bars / TOTAL) * 100).toFixed(2)}%)`;
      const frames: Keyframe[] = [{ transform: x(0), opacity: 0, offset: 0 }];
      let first = 0;
      SYLLABLES.forEach((syllable, n) => {
        frames.push({ transform: x(first), opacity: n === 0 ? 0 : 1, offset: syllable.from - (n === 0 ? 0.02 : 0) });
        if (n === 0) frames.push({ transform: x(first), opacity: 1, offset: syllable.from });
        first += syllable.bars;
        frames.push({ transform: x(first), opacity: 1, offset: syllable.to });
      });
      frames.push(
        { transform: x(TOTAL), opacity: 0, offset: SYLLABLES[SYLLABLES.length - 1]!.to + 0.03 },
        { transform: x(TOTAL), opacity: 0, offset: 1 },
      );
      animations.push(head.animate(frames, timing));
    }

    // Each label lights up while its syllable is spoken and stays lit until the wave sinks back.
    el.querySelectorAll(".syllables span").forEach((label, n) => {
      const syllable = SYLLABLES[n]!;
      animations.push(
        label.animate(
          [
            { opacity: 0.45, offset: 0 },
            { opacity: 0.45, offset: syllable.from },
            { opacity: 1, offset: syllable.from + 0.03 },
            { opacity: 1, offset: HOLD },
            { opacity: 0.45, offset: HOLD + 0.08 },
            { opacity: 0.45, offset: 1 },
          ],
          timing,
        ),
      );
    });

    return runWhileVisible(el, animations);
  }, []);

  return (
    <div className="voice" ref={root} aria-hidden="true">
      <div className="voice-wave">
        <svg viewBox={`0 0 ${TOTAL * STEP} 64`} preserveAspectRatio="none" focusable="false">
          {BARS.map((bar, i) => (
            <rect
              key={i}
              className={bar.voiced ? "hi" : undefined}
              x={i * STEP}
              y={(64 - bar.height) / 2}
              width="3"
              height={bar.height}
              rx="1"
            />
          ))}
        </svg>
        <span className="playhead">
          <i />
        </span>
      </div>
      <p className="syllables">
        {SYLLABLES.map((syllable) => (
          <span key={syllable.text}>{syllable.text}</span>
        ))}
      </p>
    </div>
  );
}
