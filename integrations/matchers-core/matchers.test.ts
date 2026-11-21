import { describe, expect, test } from "vitest";

import { QUIET } from "../../sdks/typescript/client.ts";
import { matchers } from "./index.ts";

const state = { isNot: false, timeout: "100ms", quietFor: "10ms" } as const;
const negated = { ...state, isNot: true };
const quiet = { [QUIET]: async () => ({ busy: false, quietForMs: 60_000, open: [] as string[] }) };

const ana = { id: "U0ANA", name: "Ana", kind: "user" };
const agent = { id: "A0APP", name: "my-agent", kind: "app" };
type Entry = { id: string; author: typeof ana; text: string; controls: string[]; streaming?: string };
const entry = (id: string, author: typeof ana, text: string, extra: Partial<Entry> = {}): Entry => ({
  id,
  author,
  text,
  controls: [],
  ...extra,
});
/** A conversation: no `replies()`, only what its transcript shows. `seenAs` records who it was read as. */
const conversation = (entries: Entry[], forViewer: Entry[] = []) => {
  const seenAs: unknown[] = [];
  return {
    ...quiet,
    seenAs,
    transcript: async (options: { as?: unknown } = {}) => {
      seenAs.push(options.as);
      return { entries: options.as === undefined ? entries : [...entries, ...forViewer] };
    },
  };
};
/** A thread: its replies, its root's `ts`, and a transcript. */
const thread = (root: Entry, replies: Entry[]) => ({
  ...conversation([root, ...replies]),
  ts: root.id,
  replies: async () => replies,
});
const deliveryWith = (attempt: { status: string; durationMs: number; responseStatus?: number }) => ({
  id: "Ev0TEST",
  refresh: async () => ({ attempts: [{ forgedSignature: false, ...attempt }] }),
});

describe("toBeAccepted", () => {
  test("with `within`, an acknowledgement that came too late fails, and the message says how long it took", async () => {
    const slow = deliveryWith({ status: "acknowledged", responseStatus: 200, durationMs: 2900 });
    expect((await matchers.toBeAccepted(state, slow)).pass).toBe(true);
    expect((await matchers.toBeAccepted(state, slow, { within: "3s" })).pass).toBe(true);

    const late = await matchers.toBeAccepted(state, slow, { within: "1s" });
    expect(late.pass).toBe(false);
    expect(late.message()).toBe(
      "Expected delivery Ev0TEST to be accepted within 1000ms, its first attempt is acknowledged (HTTP 200) after 2900ms",
    );
  });

  test("an attempt the agent didn't acknowledge fails with or without `within`", async () => {
    const timedOut = deliveryWith({ status: "timed_out", durationMs: 3000 });
    const result = await matchers.toBeAccepted(state, timedOut);
    expect(result.pass).toBe(false);
    expect(result.message()).toBe(
      "Expected delivery Ev0TEST to be accepted, its first attempt is timed_out after 3000ms",
    );
  });
});

describe("replies", () => {
  const question = entry("1.1", ana, "status?");

  test("toHaveReplyFrom passes on a reply, and says what the thread has when there is none", async () => {
    const answered = thread(question, [entry("1.2", agent, "all green")]);
    expect((await matchers.toHaveReplyFrom(state, answered, "my-agent")).pass).toBe(true);

    const silent = await matchers.toHaveReplyFrom(state, thread(question, [entry("1.2", ana, "hello?")]), "my-agent");
    expect(silent.pass).toBe(false);
    expect(silent.message()).toBe("Expected a reply from my-agent. The thread has:\n  Ana: hello?");

    const unwanted = await matchers.toHaveReplyFrom(negated, answered, "my-agent");
    expect(unwanted.pass).toBe(true);
    expect(unwanted.message()).toBe("Expected no reply from my-agent. The thread has:\n  my-agent: all green");
  });

  test("toHaveRepliesFrom counts exactly", async () => {
    const twice = thread(question, [entry("1.2", agent, "one"), entry("1.3", agent, "two")]);
    expect((await matchers.toHaveRepliesFrom(state, twice, "my-agent", { count: 2 })).pass).toBe(true);
    const result = await matchers.toHaveRepliesFrom(state, twice, "my-agent", { count: 1 });
    expect(result.pass).toBe(false);
    expect(result.message()).toContain("Expected exactly 1 reply from my-agent, found 2");
  });

  test("toHaveStreamingReplyFrom reads a thread's messages and a conversation's transcript alike", async () => {
    const streaming = { ...entry("1.2", agent, "Thinking"), stream: { state: "open" } };
    expect((await matchers.toHaveStreamingReplyFrom(state, thread(question, [streaming]), "my-agent")).pass).toBe(true);
    const dm = conversation([question, entry("1.2", agent, "Thinking", { streaming: "open" })]);
    expect((await matchers.toHaveStreamingReplyFrom(state, dm, "my-agent")).pass).toBe(true);
    const done = conversation([question, entry("1.2", agent, "Done", { streaming: "completed" })]);
    expect((await matchers.toHaveStreamingReplyFrom(state, done, "my-agent")).pass).toBe(false);
  });
});

describe("toContainText", () => {
  test("`as` reads the transcript as that person, handed over as the handle", async () => {
    const refusal = entry("1.2", agent, "You may not approve");
    const subject = conversation([entry("1.1", ana, "approve it")], [refusal]);
    expect((await matchers.toContainText(state, subject, "may not approve")).pass).toBe(false);
    expect((await matchers.toContainText(state, subject, "may not approve", { as: ana as never })).pass).toBe(true);
    expect(subject.seenAs.at(-1)).toBe(ana);
  });

  test("a pattern with the g flag counts every entry", async () => {
    const subject = conversation([entry("1.1", agent, "done"), entry("1.2", agent, "done")]);
    expect((await matchers.toContainText(state, subject, /done/g, { count: 2 })).pass).toBe(true);
  });
});

describe("toHaveButton", () => {
  const ask = entry("1.2", agent, "Deploy?", { controls: ["Approve", "Deny"] });
  const subject = thread(entry("1.1", ana, "deploy"), [ask]);

  test("on a thread it looks at the agent's latest message, on a message at that message", async () => {
    expect((await matchers.toHaveButton(state, subject, "Approve")).pass).toBe(true);
    expect((await matchers.toHaveButton(negated, subject, "Approve")).pass).toBe(true);
    const message = { ...quiet, ts: "1.2", thread: subject };
    expect((await matchers.toHaveButton(state, message, /^Deny$/)).pass).toBe(true);
    const root = { ...quiet, ts: "1.1", thread: subject };
    const none = await matchers.toHaveButton(state, root, "Approve");
    expect([none.pass, none.message()]).toEqual([false, 'Expected a button matching "Approve". Buttons there: none']);
  });
});

describe("toHaveReceivedCall", () => {
  test("matches by name or pattern, and counts with `times`", async () => {
    const fixture = {
      ...quiet,
      calls: async () => [{ operation: "chat.postMessage" }, { operation: "chat.postMessage" }],
    };
    expect((await matchers.toHaveReceivedCall(state, fixture, "chat.postMessage", { times: 2 })).pass).toBe(true);
    expect((await matchers.toHaveReceivedCall(state, fixture, /^chat\./g, { times: 2 })).pass).toBe(true);
    const missing = await matchers.toHaveReceivedCall(state, fixture, "reactions.add");
    expect(missing.pass).toBe(false);
    expect(missing.message()).toContain('Expected the agent to call "reactions.add", found 0');
  });
});

describe("toHaveOpenedModal", () => {
  test("looks at the modals the agent opened for a person, by title when one is given", async () => {
    const person = { ...quiet, modals: async () => [{ title: "File an incident" }] };
    expect((await matchers.toHaveOpenedModal(state, person)).pass).toBe(true);
    expect((await matchers.toHaveOpenedModal(state, person, /incident/i)).pass).toBe(true);
    const other = await matchers.toHaveOpenedModal(state, person, "Deploy");
    expect([other.pass, other.message()]).toEqual([
      false,
      'Expected a modal titled "Deploy" to have been opened. Opened: "File an incident"',
    ]);
  });
});
