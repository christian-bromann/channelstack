import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import channelstack from "../../../integrations/vitest/index.ts";

/** A project that sets the plugin's `timeout`: the SDK's own waits must take it. */
export default defineConfig({
  plugins: [channelstack({ mode: "attach", timeout: "1s" })],
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["sdk-waits.test.ts"],
  },
});
