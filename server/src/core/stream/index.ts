import { delay, type Timers } from "../clock/index.ts";

/** One server-sent event as it goes on the wire: an optional `event:` name and its `data:` text. */
export interface SseFrame {
  readonly event?: string;
  readonly data: string;
  /**
   * A frame that carries content (a text delta, a piece of tool arguments). Timing, breaks and
   * holds count these; the frames around them (a stream's start, its end) go out with their neighbours.
   */
  readonly content?: boolean;
}

/** How a stream breaks after `chunks` content frames. */
export interface StreamBreak {
  readonly chunks: number;
  /** `error`: the `errorFrames`, then the connection closes; `drop`: the connection is cut; `stall`: nothing more is sent. */
  readonly how: "error" | "drop" | "stall";
  /** For `error`: what the platform sends when a stream fails (an error event). */
  readonly errorFrames?: readonly SseFrame[];
}

export interface StreamPlan {
  readonly frames: readonly SseFrame[];
  /** Before every content frame after the first. */
  readonly betweenMs: number;
  readonly break?: StreamBreak;
  /** Hold the stream after this many content frames, until `resume()`. */
  readonly pauseAfter?: number;
}

/** How a stream ended, for the record. */
export type StreamEnd = "completed" | "errored" | "dropped" | "stalled" | "aborted";

export interface StreamHooks {
  /** The stream reached `pauseAfter` and is held. */
  paused?(): void;
  /** The stream stalled: nothing more comes until the client hangs up, which ends it as `stalled`. */
  stalled?(chunks: number): void;
  /** It ended, after `chunks` content frames. */
  ended(end: StreamEnd, chunks: number): void;
}

/** A stream being sent, and the way to let a held one go on. */
export interface SseStream {
  readonly body: ReadableStream<Uint8Array>;
  resume(): void;
}

/** How long after the last frame a cut connection is cut: enough for the server to have written what it sent. */
const DROP_AFTER_MS = 50;

/** A frame as SSE text: `event: …` when it has a name, then `data: …`, then a blank line. */
export const sseText = (frame: SseFrame): string =>
  `${frame.event === undefined ? "" : `event: ${frame.event}\n`}data: ${frame.data}\n\n`;

/**
 * A server-sent event stream with the timing and failures a plan asks for, on injected timers: a
 * delay between content frames, a hold until resumed, and a break (an error event, a cut
 * connection, or a stall). The client hanging up ends it as `aborted`.
 *
 * It is pulled: a frame is made when the reader asks for the next one, so a break comes after the
 * reader has every frame before it, as a connection cut after its bytes are on the wire would.
 */
export function sseStream(plan: StreamPlan, timers: Timers, hooks: StreamHooks): SseStream {
  const encoder = new TextEncoder();
  let release: (() => void) | undefined;
  let resumed = false;
  let finished = false;
  let stalled = false;
  let at = 0;
  let chunks = 0;
  const finish = (end: StreamEnd) => {
    if (finished) return;
    finished = true;
    hooks.ended(end, chunks);
  };
  /** Until `resume()`, or the reader hanging up. */
  const hold = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const frame = plan.frames[at];
        if (frame === undefined) {
          controller.close();
          finish("completed");
          return;
        }
        if (frame.content) {
          if (plan.break !== undefined && chunks >= plan.break.chunks) {
            const { how } = plan.break;
            if (how === "error") {
              for (const failure of plan.break.errorFrames ?? []) controller.enqueue(encoder.encode(sseText(failure)));
              controller.close();
              finish("errored");
            } else if (how === "drop") {
              // The cut comes a moment after the last bytes went out, so the reader has them, as on a real connection.
              await delay(timers, Math.max(plan.betweenMs, DROP_AFTER_MS));
              // A cut connection is an error on the reader's side, never a clean end.
              controller.error(new Error("connection reset"));
              finish("dropped");
            } else {
              stalled = true;
              hooks.stalled?.(chunks);
              await hold();
            }
            return;
          }
          if (plan.pauseAfter !== undefined && chunks === plan.pauseAfter && !resumed) {
            const held = hold();
            hooks.paused?.();
            await held;
            if (finished) return;
          }
          if (chunks > 0) await delay(timers, plan.betweenMs);
          if (finished) return;
          chunks += 1;
        }
        at += 1;
        controller.enqueue(encoder.encode(sseText(frame)));
      },
      cancel() {
        finish(stalled ? "stalled" : "aborted");
        release?.();
      },
    },
    { highWaterMark: 0 },
  );

  return {
    body,
    resume() {
      resumed = true;
      release?.();
    },
  };
}
