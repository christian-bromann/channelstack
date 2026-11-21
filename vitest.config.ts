import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{server,codegen,sdks/typescript}/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/test/integration/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["{server,sdks/typescript}/test/integration/**/*.test.ts"],
          exclude: ["server/test/integration/redaction.test.ts"],
          testTimeout: 30_000,
        },
      },
      // Needs the compiled binary: `pnpm test:accept` runs it after the examples.
      { test: { name: "acceptance", include: ["test/acceptance/*.test.ts"], testTimeout: 60_000 } },
      { test: { name: "redaction", include: ["server/test/integration/redaction.test.ts"], testTimeout: 30_000 } },
    ],
  },
});
