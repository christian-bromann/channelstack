/**
 * Hero decoration: voice waves drifting past, like audio scrolling under a playhead. One layer
 * of speech-like bars and two smooth lines move at different speeds. Each layer draws two
 * identical periods and slides by exactly one, so the loop is seamless and runs on transform
 * alone. Hidden on narrow screens and from assistive technology.
 */
const PERIOD = 600;
const HEIGHT = 200;
const MID = HEIGHT / 2;
const TAU = Math.PI * 2;

/** Bars with the bursts and pauses of speech. `t` runs 0–1 over one period. */
const BAR_COUNT = 100;
const BARS = Array.from({ length: BAR_COUNT * 2 }, (_, i) => {
  const k = i % BAR_COUNT;
  const t = k / BAR_COUNT;
  const words = Math.pow(Math.abs(Math.sin(TAU * 2.5 * t + 0.4)), 1.6);
  const phrase = 0.45 + 0.55 * Math.pow(Math.sin(Math.PI * t), 0.8);
  const jitter = 0.55 + 0.45 * (Math.abs(Math.sin(k * 12.9898) * 43758.5453) % 1);
  return { x: i * (PERIOD / BAR_COUNT), h: Math.max(2, Math.round(150 * words * phrase * jitter)) };
});

/** A smooth line: a carrier wave whose loudness swells and fades. Whole cycles per period keep it seamless. */
function line(cycles: number, swells: number, amplitude: number, phase: number) {
  const points: string[] = [];
  for (let x = 0; x <= PERIOD * 2; x += 4) {
    const t = x / PERIOD;
    const y = MID + amplitude * Math.sin(TAU * cycles * t + phase) * (0.35 + 0.65 * Math.pow(Math.sin(Math.PI * swells * t), 2));
    points.push(`${x},${y.toFixed(1)}`);
  }
  return `M${points.join("L")}`;
}

const LINE_A = line(7, 2, 62, 0);
const LINE_B = line(11, 3, 38, 1.3);

export function HeroWaves() {
  return (
    <div className="hero-waves" aria-hidden="true">
      <div className="wave-layer bars">
        <svg viewBox={`0 0 ${PERIOD * 2} ${HEIGHT}`} preserveAspectRatio="none" focusable="false">
          {BARS.map((bar, i) => (
            <rect key={i} x={bar.x} y={MID - bar.h / 2} width="2.4" height={bar.h} rx="1.2" />
          ))}
        </svg>
      </div>
      <div className="wave-layer line-b">
        <svg viewBox={`0 0 ${PERIOD * 2} ${HEIGHT}`} preserveAspectRatio="none" focusable="false">
          <path d={LINE_B} />
        </svg>
      </div>
      <div className="wave-layer line-a">
        <svg viewBox={`0 0 ${PERIOD * 2} ${HEIGHT}`} preserveAspectRatio="none" focusable="false">
          <path d={LINE_A} />
        </svg>
      </div>
    </div>
  );
}
