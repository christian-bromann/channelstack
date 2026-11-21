import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["{server,codegen,sdks/typescript}/**/*.test.ts"], exclude: ["**/node_modules/**", "**/dist/**", "server/test/**"] } },
      {
        test: {
          name: "integration",
          include: ["server/test/integration/**/*.test.ts"],
          exclude: ["server/test/integration/redaction.test.ts"],
          testTimeout: 30_000,
        },
      },
      { test: { name: "redaction", include: ["server/test/integration/redaction.test.ts"], testTimeout: 30_000 } },
    ],
  },
});
