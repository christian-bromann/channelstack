import { dirname } from "node:path";

import { expect, inject, test, type TestContext } from "vitest";

import {
  type Channelstack,
  connect,
  onRefusal,
  type Session,
  setFilesRoot,
  untilQuiet,
} from "../../sdks/typescript/client.ts";
import { type MatcherName, matchers, type MatcherState } from "../matchers-core/index.ts";

/** Runs in every test worker: one client per worker, one session per test, and the matchers. */
const server = inject("channelstack");

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
 * a person's token, the browser actor, proxy mode). The fake run never sees these refusals, so a
 * test still runs in full on every PR (reality-matrix.md, "What this means for test authors").
 */
const SKIPS_LIVE = new Set(["unsupported_in_live", "action_requires"]);
/** Each running test's `skip`, by its session: the refused request names the session, so concurrent tests skip only themselves. */
const skips = new Map<string, (note?: string) => never>();
onRefusal((error, path) => {
  const session = /^\/sessions\/([^/]+)/.exec(path)?.[1];
  const skip = session === undefined ? undefined : skips.get(session);
  if (skip && SKIPS_LIVE.has(error.code)) skip(`live: ${error.message}`);
});

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
        quiet: (options = {}) =>
          untilQuiet(() => session.quiet(), { quietFor: server.quietFor, timeout: server.timeout, ...options }),
        reset: () => channelstack.reset(),
      });
    },
    auto,
  ],
  slack: [
    async ({ channelstackSession }: Fixtures, use: (value: unknown) => Promise<void>) =>
      use(await channelstackSession.slack()),
    auto,
  ],
  github: [
    async ({ channelstackSession }: Fixtures, use: (value: unknown) => Promise<void>) =>
      use(await channelstackSession.github()),
    auto,
  ],
  linear: [
    async ({ channelstackSession }: Fixtures, use: (value: unknown) => Promise<void>) =>
      use(await channelstackSession.linear()),
    auto,
  ],
  notion: [
    async ({ channelstackSession }: Fixtures, use: (value: unknown) => Promise<void>) =>
      use(await channelstackSession.notion()),
    auto,
  ],
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
