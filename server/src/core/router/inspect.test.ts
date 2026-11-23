import { describe, expect, test } from "vitest";

import { systemClock } from "../clock/index.ts";
import { EventLog, WORLD_SCOPE } from "../events/index.ts";
import { Redactor } from "../redact/index.ts";
import { readCalls, recordCall } from "./inspect.ts";

const call = {
  operation: "chat.postMessage",
  method: "POST",
  path: "/api/chat.postMessage",
  request: { text: "hi" },
  responseStatus: 200,
  response: { ok: true },
  durationMs: 3,
};

describe("recording the agent's API calls", () => {
  test("a call is on record for each session it was about, once", () => {
    const events = new EventLog(systemClock, new Redactor());
    recordCall(events, "slack", ["ses_a", "ses_b", "ses_a", undefined], call, { unattributed: "drop" });
    expect(readCalls(events, "ses_a", "slack", {})).toHaveLength(1);
    expect(readCalls(events, "ses_b", "slack", {})).toMatchObject([
      { operation: "chat.postMessage", channel: "slack" },
    ]);
  });

  test("a call about no session is kept for none, or dropped", () => {
    const events = new EventLog(systemClock, new Redactor());
    recordCall(events, "linear", [], call, { unattributed: "world" });
    recordCall(events, "slack", [undefined], call, { unattributed: "drop" });
    expect(events.read(WORLD_SCOPE).events.map((event) => event.driver)).toEqual(["linear"]);
  });

  test("a request or answer too large to keep is left out; the error code stays", () => {
    const events = new EventLog(systemClock, new Redactor());
    const large = { text: "x".repeat(70 * 1024) };
    recordCall(
      events,
      "slack",
      ["ses_a"],
      { ...call, request: large, response: large, error: "msg_too_long" },
      {
        unattributed: "drop",
      },
    );
    const [recorded] = readCalls(events, "ses_a", "slack", { error: "true" });
    expect(recorded).toMatchObject({ error: "msg_too_long" });
    expect(recorded?.request).toBeUndefined();
    expect(recorded?.response).toBeUndefined();
  });
});
