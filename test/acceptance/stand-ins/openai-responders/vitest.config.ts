import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import channelstack from "../../../../integrations/vitest/index.ts";

/** The responder tests `openai-no-script.test.ts` runs and expects to pass (exit check 13.6). */
export default defineConfig({
  plugins: [channelstack({ mode: "attach" })],
  test: {
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    include: ["test/acceptance/stand-ins/openai-responders/responders.ts"],
  },
});
