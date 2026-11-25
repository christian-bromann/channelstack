import { defineConfig } from "vitest/config";

// The site's own tests. website/examples holds the docs' examples, which run against a server
// elsewhere (pnpm test:rust and friends at the root), so they aren't collected here.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
