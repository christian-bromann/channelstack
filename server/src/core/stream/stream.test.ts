/**
 * Streams with timing, holds and breaks, on timers the test moves itself (exit check 13.7): the
 * delay between content frames, a hold until resumed, and each way a stream breaks, as the reader
 * sees it and as the stream records its end.
 */
import { describe, expect, test } from "vitest";

import type { Timers } from "../clock/index.ts";
import { type SseFrame, sseStream, type StreamEnd } from "./index.ts";

/** Timers that run only when the test lets time pass. */
function manualTimers() {
  let now = 0;
  let tasks: Array<{ at: number; run: () => void }> = [];
  const timers: Timers = {
    after(delayMs, run) {
      const task = { at: now + delayMs, run };
      tasks.push(task);
      return () => {
        tasks = tasks.filter((other) => other !== task);
      };
    },
  };
  return {
    timers,
    /** Let this much time pass, running what falls due, and let the stream go on. */
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const [next] = tasks.filter((task) => task.at <= until).sort((a, b) => a.at - b.at);
        if (!next) break;
        tasks = tasks.filter((task) => task !== next);
        now = next.at;
        next.run();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const frames: SseFrame[] = [
  { data: "start" },
  { data: "one", content: true },
  { data: "two", content: true },
  { data: "three", content: true },
  { data: "[DONE]" },
];

/** Read a stream as it comes: the data lines so far, and how it ended for the reader. */
function reader(body: ReadableStream<Uint8Array>) {
  const seen: string[] = [];
  const decoder = new TextDecoder();
  let failed: unknown;
  let done = false;
  const reading = body.getReader();
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done: finished } = await reading.read();
        if (finished) break;
        for (const line of decoder.decode(value).split("\n")) if (line.startsWith("data: ")) seen.push(line.slice(6));
      }
      done = true;
    } catch (error) {
      failed = error;
    }
  })();
  return { seen, pump, cancel: () => reading.cancel(), failed: () => failed, done: () => done };
}

describe("timing", () => {
  test("content frames wait betweenMs apart; the frames around them go with their neighbours", async () => {
    const clock = manualTimers();
    const ended: StreamEnd[] = [];
    const stream = sseStream({ frames, betweenMs: 100 }, clock.timers, { ended: (end) => ended.push(end) });
    const read = reader(stream.body);

    await settle();
    expect(read.seen).toEqual(["start", "one"]);
    await clock.advance(99);
    expect(read.seen).toEqual(["start", "one"]);
    await clock.advance(1);
    expect(read.seen).toEqual(["start", "one", "two"]);
    await clock.advance(100);
    await read.pump;

    expect(read.seen).toEqual(["start", "one", "two", "three", "[DONE]"]);
    expect(ended).toEqual(["completed"]);
  });
});

describe("holds", () => {
  test("pauseAfter holds the stream until resume(), and says it is held", async () => {
    const clock = manualTimers();
    let paused = 0;
    const stream = sseStream({ frames, betweenMs: 0, pauseAfter: 1 }, clock.timers, {
      paused: () => {
        paused += 1;
      },
      ended: () => {},
    });
    const read = reader(stream.body);

    await clock.advance(1000);
    expect(read.seen).toEqual(["start", "one"]);
    expect(paused).toBe(1);

    stream.resume();
    await read.pump;
    expect(read.seen).toEqual(["start", "one", "two", "three", "[DONE]"]);
  });

  test("the reader hanging up while held ends it as aborted", async () => {
    const clock = manualTimers();
    const ended: Array<[StreamEnd, number]> = [];
    const stream = sseStream({ frames, betweenMs: 0, pauseAfter: 2 }, clock.timers, {
      ended: (end, chunks) => ended.push([end, chunks]),
    });
    const read = reader(stream.body);
    await clock.advance(10);

    await read.cancel();

    expect(ended).toEqual([["aborted", 2]]);
  });
});

describe("breaks", () => {
  test("error: the error frames after the chunks before it, then a clean close", async () => {
    const clock = manualTimers();
    const ended: Array<[StreamEnd, number]> = [];
    const stream = sseStream(
      { frames, betweenMs: 0, break: { chunks: 2, how: "error", errorFrames: [{ data: '{"error":{}}' }] } },
      clock.timers,
      { ended: (end, chunks) => ended.push([end, chunks]) },
    );
    const read = reader(stream.body);
    await clock.advance(10);
    await read.pump;

    expect(read.seen).toEqual(["start", "one", "two", '{"error":{}}']);
    expect(read.done()).toBe(true);
    expect(ended).toEqual([["errored", 2]]);
  });

  test("drop: the reader has every chunk before it, then the connection is cut", async () => {
    const clock = manualTimers();
    const ended: StreamEnd[] = [];
    const stream = sseStream({ frames, betweenMs: 0, break: { chunks: 1, how: "drop" } }, clock.timers, {
      ended: (end) => ended.push(end),
    });
    const read = reader(stream.body);
    // In steps: the cut is scheduled once the reader has asked for what comes after the last chunk.
    for (let step = 0; step < 10; step += 1) await clock.advance(10);
    await read.pump;

    expect(read.seen).toEqual(["start", "one"]);
    expect(read.failed()).toBeInstanceOf(Error);
    expect(ended).toEqual(["dropped"]);
  });

  test("stall: nothing more comes until the reader hangs up, which ends it as stalled", async () => {
    const clock = manualTimers();
    const ended: StreamEnd[] = [];
    let stalledAt: number | undefined;
    const stream = sseStream({ frames, betweenMs: 0, break: { chunks: 1, how: "stall" } }, clock.timers, {
      stalled: (chunks) => {
        stalledAt = chunks;
      },
      ended: (end) => ended.push(end),
    });
    const read = reader(stream.body);
    await clock.advance(60_000);
    expect(read.seen).toEqual(["start", "one"]);
    expect(stalledAt).toBe(1);
    expect(ended).toEqual([]);

    await read.cancel();
    expect(ended).toEqual(["stalled"]);
  });
});
