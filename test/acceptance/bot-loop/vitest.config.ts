import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import channelstack from "../../../integrations/vitest/index.ts";

/** A project with the plugin and nothing else, whose one test leaves a bot loop for its fixture to fail. */
export default defineConfig({
  plugins: [channelstack({ mode: "attach" })],
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["loop.test.ts"],
  },
});
