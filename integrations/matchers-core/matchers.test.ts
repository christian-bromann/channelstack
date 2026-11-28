import { describe, expect, test } from "vitest";

import { ChannelstackError, QUIET } from "../../sdks/typescript/client.ts";
import { CONTEXT } from "../../sdks/typescript/runtime/client.ts";
import { matchers, modelNotes } from "./index.ts";

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

describe("a failure's message", () => {
  test("leaves out what is still open when the server can't tell (live), and still fails", async () => {
    // Live, without proxy mode, the server refuses to say when the agent is done.
    const refused = async () => {
      throw new ChannelstackError("action_requires", 422, "Session.quiet live needs proxy mode");
    };
    const issue = { [QUIET]: refused, comments: async () => [] };
    const result = await matchers.toHaveCommentFrom(state, issue, agent);
    expect(result.pass).toBe(false);
    expect(result.message()).not.toContain("Still open");
  });
});

describe("comments", () => {
  test("on a Notion page, the comment matchers say to pass a discussion: a page has no comments of its own", async () => {
    const page = { ...quiet, title: "Spec", discussions: async () => [], blocks: async () => [] };
    const wanted = "needs a Notion discussion, not a page: a page's comments are in its discussions.";
    const positive = matchers.toHaveCommentFrom(state, page, agent);
    await expect(positive).rejects.toThrow(`toHaveCommentFrom ${wanted}`);
    await expect(positive).rejects.not.toBeInstanceOf(TypeError);
    await expect(matchers.toHaveCommentsFrom(state, page, agent, { count: 1 })).rejects.toThrow(
      `toHaveCommentsFrom ${wanted}`,
    );
  });

  test("on a discussion, they read its comments", async () => {
    const discussion = { ...quiet, comments: async () => [{ author: agent, text: "Summary: all green" }] };
    expect((await matchers.toHaveCommentFrom(state, discussion, agent, { text: /green/ })).pass).toBe(true);
    expect((await matchers.toHaveCommentsFrom(state, discussion, agent, { count: 1 })).pass).toBe(true);
  });
});

describe("the model", () => {
  /** A script whose calls are these: what `toHaveAnswered` counts. */
  const script = (responses: Array<{ text?: string; error?: string }>, problems: string[] = []) => ({
    ...quiet,
    id: "ms_1",
    refresh: async () => ({ used: responses.length, problems }),
    calls: async () => responses.map((response) => ({ response })),
  });

  test("toHaveAnswered counts the turns that reached the agent, not those the fake refused", async () => {
    const refused = script(
      [{ error: "channelstack_no_script" }],
      ["ms_1 called `search_incidents`, but the request offered no tools"],
    );
    const result = await matchers.toHaveAnswered(state, refused);
    expect(result.pass).toBe(false);
    expect(result.message()).toBe(
      "Expected script ms_1 to answer a call, it answered 0. Its problems:\n  ms_1 called `search_incidents`, but the request offered no tools",
    );

    // A held call (a responder still answering) isn't answered yet; a scripted error is an answer.
    expect((await matchers.toHaveAnswered(state, script([{}]))).pass).toBe(false);
    const answered = script([
      { text: "All good." },
      { error: "rate_limit_exceeded" },
      { error: "channelstack_no_script" },
    ]);
    expect((await matchers.toHaveAnswered(state, answered, { times: 2 })).pass).toBe(true);
  });

  test("toHaveSent compares text as attribution does: a Slack link is its URL", async () => {
    const call = {
      ...quiet,
      request: { text: "Ana: Deploy   https://example.com/runs/7 NOW", tools: [] },
    };
    const sent = await matchers.toHaveSent(state, call, {
      text: "<@U08B5K2M9QX> deploy <https://example.com/runs/7|the run> now",
    });
    expect(sent.pass).toBe(true);
  });

  /** A handle in session `ses_1` whose server answers these model reads. */
  const inSession = (reads: { unattributed?: unknown[]; calls?: unknown[] }, asked: unknown[] = []) => ({
    ...quiet,
    [CONTEXT]: () => ({
      session: "ses_1",
      transport: {
        request: async (_method: string, path: string, options?: { query?: unknown }) => {
          asked.push([path, options?.query]);
          return path.endsWith("/unattributed") ? (reads.unattributed ?? []) : (reads.calls ?? []);
        },
      },
    }),
    replies: async () => [],
  });

  test("a failing check names the model calls no session claimed, recent ones only", async () => {
    const asked: unknown[] = [];
    const subject = inSession(
      {
        unattributed: [
          {
            id: "chatcmpl-1",
            lastUserText: "summarise the backlog",
            sinceMs: 2400,
            message: "this call couldn't be attributed to any test: nothing in it matches.",
          },
        ],
      },
      asked,
    );
    const result = await matchers.toHaveReplyFrom(state, subject, "my-agent");
    expect(result.pass).toBe(false);
    expect(result.message()).toBe(
      [
        "Expected a reply from my-agent. The thread has:\n  (nothing)",
        "1 model call in the last 10s couldn't be attributed to a test:",
        '  chatcmpl-1 ("summarise the backlog", 2s ago): this call couldn\'t be attributed to any test: nothing in it matches.',
      ].join("\n"),
    );
    expect(asked).toContainEqual(["/sessions/ses_1/openai/unattributed", { withinMs: 10_000 }]);

    // A check that passes reads nothing more.
    asked.length = 0;
    expect((await matchers.toHaveReplyFrom(negated, subject, "my-agent")).pass).toBe(false);
    expect(asked).toEqual([]);
  });

  test("a failing check names the sessions a call attributed by order tied with", async () => {
    const byOrder = (id: string) => ({
      id,
      request: { context: { attributedBy: "order", matched: "@my-agent hello", tiedWith: ["ses_2"] } },
    });
    const subject = inSession({
      calls: [byOrder("chatcmpl-1"), { id: "chatcmpl-2", request: { context: { attributedBy: "text" } } }],
    });
    const result = await matchers.toHaveReplyFrom(state, subject, "my-agent");
    expect(result.message()).toBe(
      [
        "Expected a reply from my-agent. The thread has:\n  (nothing)",
        'Model call chatcmpl-1 was attributed by order, between 2 sessions that all sent "@my-agent hello" (this one and ses_2): each went to the oldest unanswered message. Give each test\'s prompt something of its own, or have the agent send `user`.',
      ].join("\n"),
    );
    const [both, ...more] = modelNotes([], [byOrder("chatcmpl-1"), byOrder("chatcmpl-3")]);
    expect(both).toMatch(/^Model calls chatcmpl-1, chatcmpl-3 were attributed by order, between 2 sessions/);
    expect(more).toEqual([]);
  });

  test("a failing check adds nothing when the server can't say (live)", async () => {
    const subject = {
      ...quiet,
      [CONTEXT]: () => ({
        session: "ses_1",
        transport: {
          request: async () => {
            throw new ChannelstackError("unsupported_in_live", 422, "the fake OpenAI isn't live");
          },
        },
      }),
      replies: async () => [],
    };
    const result = await matchers.toHaveReplyFrom(state, subject, "my-agent");
    expect(result.message()).toBe("Expected a reply from my-agent. The thread has:\n  (nothing)");
  });
});
