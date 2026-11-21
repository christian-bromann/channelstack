import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import channelstack from "../../integrations/vitest/index.ts";

/**
 * The acceptance suite: `api/examples` run unchanged against a reference agent and the compiled
 * binary. `scripts/accept.ts` starts both and names the `describe` blocks this phase has enabled.
 */
export default defineConfig({
  plugins: [channelstack({ mode: "attach" })],
  resolve: {
    alias: {
      // The examples import the published names; here they resolve to the sources in this repository.
      "channelstack/vitest": fileURLToPath(new URL("../../integrations/vitest/index.ts", import.meta.url)),
    },
  },
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["api/examples/slack.test.ts"],
    testTimeout: 30_000,
  },
});
