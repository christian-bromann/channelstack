import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import channelstack from "../../../integrations/vitest/index.ts";

/** A project the way a quickstart sets it up: the plugin and nothing else, so no `testTimeout` of its own. */
export default defineConfig({
  plugins: [channelstack({ mode: "attach" })],
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["no-reply.test.ts"],
  },
});
