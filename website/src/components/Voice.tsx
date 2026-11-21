import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/hooks";

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
      texture === "vowel" ? Math.pow(Math.sin(Math.PI * (0.08 + 0.84 * t)), 0.45) * (0.82 + 0.18 * Math.cos(k * 1.9))
      : texture === "nasal" ? 0.8 + 0.2 * Math.sin(Math.PI * t)
      : texture === "hiss" ? 0.55 + 0.45 * n
      : texture === "burst" ? 1 - 0.55 * t + 0.2 * n
      : texture === "decay" ? 1 - 0.8 * t
      : 1;
    return { height: Math.max(2, Math.round(60 * level * shape)), voiced };
  }),
);

const TOTAL = BARS.length;
const STEP = 5;

export function Voice() {
  const svg = useRef<SVGSVGElement>(null);

  // Bars rise from left to right, as if the word were being spoken, then rest and repeat.
  // The Web Animations API keeps this on transform only and needs no inline styles.
  useEffect(() => {
    const el = svg.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== "function" || typeof IntersectionObserver === "undefined") return;
    const animations = Array.from(el.querySelectorAll("rect")).map((rect, i) => {
      const animation = rect.animate(
        [
          { transform: "scaleY(0.08)", offset: 0 },
          { transform: "scaleY(1.25)", offset: 0.045 },
          { transform: "scaleY(0.9)", offset: 0.08 },
          { transform: "scaleY(1)", offset: 0.12 },
          { transform: "scaleY(1)", offset: 0.82 },
          { transform: "scaleY(0.08)", offset: 0.9 },
          { transform: "scaleY(0.08)", offset: 1 },
        ],
        { duration: 5200, delay: i * 13, iterations: Infinity, easing: "ease-out", fill: "backwards" },
      );
      animation.pause();
      return animation;
    });
    const observer = new IntersectionObserver(([entry]) => {
      const run = entry?.isIntersecting && document.documentElement.getAttribute("data-motion") !== "paused";
      animations.forEach((animation) => (run ? animation.play() : animation.pause()));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      animations.forEach((animation) => animation.cancel());
    };
  }, []);

  return (
    <div className="voice" aria-hidden="true">
      <svg ref={svg} viewBox={`0 0 ${TOTAL * STEP} 64`} preserveAspectRatio="none" focusable="false">
        {BARS.map((bar, i) => (
          <rect key={i} className={bar.voiced ? "hi" : undefined} x={i * STEP} y={(64 - bar.height) / 2} width="3" height={bar.height} rx="1" />
        ))}
      </svg>
      <p className="syllables">
        <span>chan</span>
        <span>nel</span>
        <span>stack</span>
      </p>
    </div>
  );
}
