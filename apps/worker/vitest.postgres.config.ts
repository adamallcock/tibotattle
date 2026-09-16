import { defineConfig } from "vitest/config";

// Opt-in real database lane. The test creates and drops its own local database.
export default defineConfig({
  test: {
    environment: "node",
    include: ["postgres-test/**/*.spec.mjs"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
