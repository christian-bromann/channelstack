import { dirname } from "node:path";

import { expect, inject, test, type TestContext } from "vitest";

import {
  type Channelstack,
  ChannelstackError,
  connect,
  onRefusal,
  type Session,
  setFilesRoot,
  setWaitDefaults,
  untilQuiet,
} from "../../sdks/typescript/client.ts";
import { type MatcherName, matchers, type MatcherState } from "../matchers-core/index.ts";
import { refusedFixture, SKIPS_LIVE, unskipped } from "./refused.ts";

/** Runs in every test worker: one client per worker, one session per test, and the matchers. */
const server = inject("channelstack");
// The plugin's `timeout` and `quietFor` are every SDK wait's defaults, not only the matchers':
// `thread.waitForReply()`, `latestReply()`, `delivery.settled()`, …
setWaitDefaults({ timeout: server.timeout, quietFor: server.quietFor });

let client: Promise<Channelstack> | undefined;
const connected = () => {
  // The worker attaches to the server the global setup found; it never starts one itself. The
  // token is handed over directly, so nothing a test spawns inherits it.
  client ??= connect({ mode: "attach", server: server.url, token: server.token });
  return client;
};

/**
 * What live mode can't do skips the test, with the reason, instead of failing it: a fake-only
 * feature (`unsupported_in_live`), or one that needs a piece this run doesn't have (`action_requires`:
 * the browser actor, proxy mode). The fake run never sees these refusals, so a
 * test still runs in full on every PR (reality-matrix.md, "What this means for test authors").
 */
/** Each running test's `skip`, by its session: the refused request names the session, so concurrent tests skip only themselves. */
const skips = new Map<string, (note?: string) => never>();
onRefusal((error, path) => {
  const session = /^\/sessions\/([^/]+)/.exec(path)?.[1];
  if (session === undefined || unskipped.has(session)) return;
  const skip = skips.get(session);
  if (skip && SKIPS_LIVE.has(error.code)) skip(`live: ${error.message}`);
});

/**
 * A channel's fixture. Every test gets all four, so a channel that is refused live (its live
 * backend isn't built, its credentials are set in part) must not touch the tests of the others:
 * the refusal is kept, and comes when the test first uses that channel. It skips the test or fails
 * it, as the refusal would have.
 */
function channelFixture(open: (session: Session) => Promise<unknown>) {
  return async (
    { channelstackSession: session, skip }: Fixtures & { skip(note?: string): never },
    use: (value: unknown) => Promise<void>,
  ) => {
    let fixture: unknown;
    // A refusal while setting up is kept for the test's first use of that channel.
    unskipped.add(session.sessionId);
    try {
      fixture = await open(session);
    } catch (error) {
      const refuse = () => {
        if (error instanceof ChannelstackError && SKIPS_LIVE.has(error.code)) skip(`live: ${error.message}`);
        throw error;
      };
      fixture = refusedFixture(refuse);
    } finally {
      unskipped.delete(session.sessionId);
    }
    await use(fixture);
  };
}

/**
 * The fixtures, registered on Vitest's own `test` so that a suite's `test.extend` can build on
 * them (`ana: async ({ slack }, use) => …`). They are automatic: every test has its session,
 * opened before its hooks run and closed after them, whether it names a fixture or not.
 */
type Fixtures = Pick<TestContext, "channelstack" | "slack" | "github" | "linear" | "notion"> & {
  channelstackSession: Session;
};
const auto = { auto: true } as const;

(test as unknown as { override(fixtures: Record<string, unknown>): void }).override({
  channelstackSession: [
    async (
      { task, skip }: { task: { file: { filepath: string } }; skip(note?: string): never },
      use: (session: Session) => Promise<void>,
    ) => {
      const session = await (await connected()).openSession();
      // A fixture path in a test (`files: "./fixtures/web"`) starts from the test file, like an import.
      setFilesRoot(dirname(task.file.filepath));
      skips.set(session.sessionId, skip);
      try {
        await use(session);
      } finally {
        skips.delete(session.sessionId);
        // Closing the session removes everything the test created. Disposing never fails a test.
        await session[Symbol.asyncDispose]();
      }
    },
    auto,
  ],
  channelstack: [
    async ({ channelstackSession: session }: Fixtures, use: (value: Fixtures["channelstack"]) => Promise<void>) => {
      const channelstack = await connected();
      await use({
        url: server.url,
        env: () => channelstack.env(),
        quiet: (options = {}) => untilQuiet(() => session.quiet(), options),
        reset: () => channelstack.reset(),
      });
    },
    auto,
  ],
  slack: [channelFixture((session) => session.slack()), auto],
  github: [channelFixture((session) => session.github()), auto],
  linear: [channelFixture((session) => session.linear()), auto],
  notion: [channelFixture((session) => session.notion()), auto],
});

expect.extend(
  // Vitest types a matcher's `this` as its own state; the adapter only needs `isNot` from it.
  Object.fromEntries(
    (Object.keys(matchers) as MatcherName[]).map((name) => [
      name,
      function (this: { isNot?: boolean; equals?: MatcherState["equals"] }, subject: unknown, ...args: unknown[]) {
        const state: MatcherState = {
          isNot: this.isNot === true,
          timeout: server.timeout,
          quietFor: server.quietFor,
          ...(this.equals ? { equals: this.equals } : {}),
        };
        return (matchers[name] as (state: MatcherState, subject: unknown, ...rest: unknown[]) => unknown)(
          state,
          subject,
          ...args,
        );
      },
    ]),
  ) as never,
);
