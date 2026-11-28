import { describe, expect, test } from "vitest";

import { systemClock } from "../clock/index.ts";
import { EventLog } from "../events/index.ts";
import { Redactor } from "../redact/index.ts";
import { LoopGuard } from "./index.ts";

const guard = (limit: number) => {
  const events = new EventLog(systemClock, new Redactor());
  return { events, loops: new LoopGuard(events, limit).for("slack"), guard: new LoopGuard(events, limit) };
};

describe("exit check 12.6: the loop guard", () => {
  test("app messages with no person between them stop the conversation at the limit, and say so", () => {
    const events = new EventLog(systemClock, new Redactor());
    const loops = new LoopGuard(events, 4);
    const slack = loops.for("slack");
    for (let i = 0; i < 4; i++) slack.wrote("s1", "C1", { kind: "app", name: i % 2 === 0 ? "my-agent" : "coder" });
    expect(slack.allows("s1", "C1")).toBe(true);
    slack.wrote("s1", "C1", { kind: "app", name: "my-agent" });

    expect(slack.allows("s1", "C1")).toBe(false);
    expect(slack.allows("s1", "C2")).toBe(true);
    expect(slack.allows("s2", "C1")).toBe(true);
    expect(loops.stopped("s1")).toEqual([
      "a bot loop in slack C1 (4 app messages with no person between them: my-agent → coder → my-agent → coder → my-agent …)",
    ]);
    const [stopped] = events.read("s1").events.filter((event) => event.kind === "bot_loop");
    expect(stopped).toMatchObject({
      driver: "slack",
      data: { conversation: "C1", messages: 4, authors: ["my-agent", "coder"] },
    });
    expect(stopped?.summary).toMatchObject({ ok: false });
  });

  test("a person's message starts the count over", () => {
    const { loops } = guard(3);
    for (let i = 0; i < 3; i++) loops.wrote("s1", "C1", { kind: "app", name: "coder" });
    loops.wrote("s1", "C1", { kind: "person" });
    for (let i = 0; i < 3; i++) loops.wrote("s1", "C1", { kind: "app", name: "coder" });
    expect(loops.allows("s1", "C1")).toBe(true);
  });

  test("a closed session's loops go with it", () => {
    const { guard: loops } = guard(1);
    loops.wrote("s1", "slack", "C1", { kind: "app", name: "coder" });
    loops.wrote("s1", "slack", "C1", { kind: "app", name: "coder" });
    expect(loops.stopped("s1")).toHaveLength(1);
    loops.forget("s1");
    expect(loops.stopped("s1")).toEqual([]);
    expect(loops.allows("s1", "slack", "C1")).toBe(true);
  });

  test("one call records who wrote and answers whether what it causes is still delivered", () => {
    const { loops } = guard(2);
    expect(loops.wrote("s1", "C1", { kind: "app", name: "coder" })).toBe(true);
    expect(loops.wrote("s1", "C1", { kind: "app", name: "my-agent" })).toBe(true);
    expect(loops.wrote("s1", "C1", { kind: "app", name: "coder" })).toBe(false);
    expect(loops.wrote("s1", "C1", { kind: "app", name: "my-agent" })).toBe(false);
    expect(loops.wrote("s1", "C1", { kind: "person" })).toBe(true);
    expect(loops.wrote("s1", "C1", { kind: "app", name: "coder" })).toBe(true);
  });
});
