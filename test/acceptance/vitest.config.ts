import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import channelstack from "../../integrations/vitest/index.ts";

/**
 * The acceptance suite: `api/examples` run unchanged against a reference agent and the compiled
 * binary, and the tests in `stack/` that need the same pair. `scripts/accept.ts` starts both and
 * names the `describe` blocks of the examples this phase has enabled.
 */
export default defineConfig({
  plugins: [channelstack({ mode: "attach" })],
  resolve: {
    alias: {
      // The examples import the published names; here they resolve to the sources in this repository.
      "channelstack/vitest": fileURLToPath(new URL("../../integrations/vitest/index.ts", import.meta.url)),
      "channelstack/checks": fileURLToPath(new URL("../../integrations/checks/index.ts", import.meta.url)),
    },
  },
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: [
      "api/examples/slack.test.ts",
      "api/examples/github.test.ts",
      "api/examples/linear.test.ts",
      "api/examples/notion.test.ts",
      "test/acceptance/stack/**/*.test.ts",
      "test/acceptance/checks/**/*.test.ts",
    ],
    // Runs after each test, while its session is still open (the plugin closes it last).
    setupFiles: [
      fileURLToPath(new URL("./github-schemas.setup.ts", import.meta.url)),
      fileURLToPath(new URL("./linear-schemas.setup.ts", import.meta.url)),
    ],
    testTimeout: 30_000,
    // Exit check 1.7 runs 20 tests at the same moment; Vitest's default is 5 at a time.
    maxConcurrency: 20,
  },
});
