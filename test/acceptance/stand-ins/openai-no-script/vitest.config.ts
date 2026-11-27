import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import channelstack from "../../../../integrations/vitest/index.ts";

/** The tests `openai-no-script.test.ts` runs and expects to fail: an unscripted model call fails them. */
export default defineConfig({
  plugins: [channelstack({ mode: "attach" })],
  test: {
    root: fileURLToPath(new URL("../../../..", import.meta.url)),
    include: ["test/acceptance/stand-ins/openai-no-script/fails.ts"],
  },
});
